# Notarium MCP gateway — the contract for agents (#21)

The canon of the agent contract (#21). This is Notarium's **semantic MCP gateway**: one endpoint, twenty-three intent-oriented tools through which an AI agent reads and writes the knowledge base — instead of direct calls to the storage engine. The tool spec (names/signatures/rationale) — the toolset-v1 spec from the gateway tool-design spike; the note ontology (classes, what goes where) — [docs/note-model.md](note-model.md#note-ontology); the threat model — the agent-security threat model from that same spike. Here — how to use it.

Why a gateway and not "just give the agent the engine." Direct access to the storage engine hands the agent generic CRUD with no boundaries: no token scope, no provenance, no poka-yoke on class/visibility, and — most importantly — it assembles the "lethal trifecta" (private data × untrusted note content × an outbound channel). The gateway gives a narrow intent set where each axis of the trifecta is broken by construction (see "Security"). This is not a wrapper for convenience — it is a trust boundary.

## Connection <a id="connect"></a>

- **Endpoint:** `POST /mcp` — the streamable-HTTP transport of the official `@modelcontextprotocol/sdk`, stateless (a fresh server per request, scoped to the token), one JSON response (not SSE). `GET`/`DELETE` → `405` (no server-initiated streams). Compatible with the Claude API MCP connector and any HTTP-MCP client.
- **Authentication:** `Authorization: Bearer <pat>`. A PAT is minted in the UI (the tokens section) or via `POST /api/me/tokens` (needs the `self:manage` scope). Without a valid token in `password` mode — `401`, **with no** SYSTEM fallback (an agent must present a token).
- **Web UI claude.ai / chatgpt.com (custom connector):** there you cannot paste a PAT — only OAuth. Notarium ships a thin **OAuth 2.1 facade** (#96, [docs/mcp-oauth.md](mcp-oauth.md)): a `401` on `/mcp` returns `WWW-Authenticate` with discovery (RFC 9728/8414), `/oauth/authorize` (login with our session + consent) → `/oauth/token` (PKCE S256) issues a token mapped to the same principal. CIMD-first + a DCR fallback. In `none` mode there is no facade — the server is added as an authless connector.
- **Token scope = the agent's ceiling.** A read-only PAT **does not see** write tools in `tools/list` (least privilege: a tool does not "appear and refuse", it is absent). A PAT's grant set = the spaces the agent can reach; another space is unreachable in principle.
- **`none` mode** (desktop/dev, an explicit operator opt-out): a single SYSTEM principal, no auth — same as REST there.
- **`initialize`** returns the server `instructions` (the main lever for call order) — static text; note content is **never** mixed into it (anti tool-poisoning).

## Twenty-three tools <a id="tools"></a>

The names/descriptions the agent sees in `tools/list` are static and live in [descriptions.ts](../packages/server/src/services/mcp/descriptions.ts). A summary:

**Bootstrap**
- `start_session` — call it **first** in a new session. It opens/resumes an agent episode and, when one episode binds unambiguously, returns `session.id`; retain that id and pass it as the top-level `session` argument on every later session-aware tool. In one round-trip it also returns the user profile (always-load), accessible projects and, with a `project` hint, a **compact index** of the project (a note count + top-level folders — enumerate via `list_notes`), the bound episode's own delta of changes since its last visit and `knownValues`. Without a bound episode (including ambiguous name matching), the delta follows the owner fallback. `acknowledge:false` peeks without advancing but still freezes a bound episode's independent starting position. An acknowledge advances the bound episode plus its owner fallback, or only that fallback when no episode binds; every write is monotonic, so a slower, older concurrent response cannot rewind the next delta window. Not calling it just means less context: the other tools work on their own. Curating WHAT lands in `profile.alwaysLoad`/`project.alwaysLoad` — the Agents → Context section ([docs/projects.md](projects.md#init-context-curation)): manual pins in place (`always-load`), **context sets + cross-space loose pins** and muting memory.
  Its `roles` section contains only compact summaries from libraries the human explicitly owns;
  the packaged catalog is never effective by itself. Pass `role` (`name` is a compatibility alias)
  to activate one in the same call. Its exact owned placement also selects the role context preset;
  `activeRole.context.alwaysLoad` carries the role-only loaded refs before the base context.
- `list_roles` — page through the complete bounded inventory of effective roles after
  `start_session.rolesTruncated:true`, or whenever its compact first page is insufficient. It
  accepts the same project hint and returns only owned Personal/Space/Project roles, never catalog
  templates. An underlying host/library cap is reported as `truncated:true` on this tool.
- `use_role` — activate one effective role and load its instructions plus linked Agent Skills under
  `budgetTokens`. Use the same project handle as `start_session` so
  `Project > Space > Personal` precedence resolves identically. Repeating the selected name is an
  idempotent success, but resolves and reloads the effective package because a narrower fork may
  now win; an unknown or catalog-only name reports the roles actually available. `context` returns
  the same role-only always-load slice plus `replacement`, the complete surviving base profile and
  optional project slice. It replaces the base from `start_session`; omitted refs were evicted by
  the role-first shared-budget scan.
- `whoami` — who I am and what I may do (principal-id, the read|write ceiling, project memberships) + the engine's `capabilities` (`vector`/`trash`/`revisions`) — so as not to probe blindly.
- `get_my_projects` — the list of accessible projects with their slugs (for the `project` argument — do not guess the slug). The personal domain is **not** in the list (it is implied by the token).

**Discover / navigate**
- `list_notes` — `ls` of the knowledge base: the direct notes and subfolders of a folder (deterministic, paginated). `project` picks a space and narrows to it; `path` is a **space-relative** folder (take the `path` from a `folders` entry / a hit verbatim, do not construct it) — without it, the project root. `tag` filters by a tag. Returns `items` (direct notes: id/title/path/tags) + `folders` (direct subfolders with a subtree count) + an honest `total`; page with `cursor`/`nextCursor`. Lists the user-visible notes (not agent-memory — for it use `search`).
- `recent_activity` — the most recently edited notes (absolute freshness from the journal) — "what was touched lately, needs a review." This is **not** the delta from `start_session`: that delta follows a bound episode cursor, or the owner fallback when no episode binds; `recent_activity` ignores either cursor and always shows the latest changes. `project` narrows it; without it, the freshest across the whole reach. Each entry: who (`principal` — human/agent), how (`kind`), where (`path`/`project`), when (`modifiedAt`). `truncated:true` — there was more.

**Read / recall**
- `search` — hybrid search (semantics + lexical via RRF, #81) over the reachable knowledge, with an honest degradation to FTS when the vector channel is unavailable. **It also covers the agent's own agent-memory** (#102): "search before writing" now dedupes memory too (the only class without title-collision dedup) — **always search before writing**. `project` narrows it to a project (its notes + its memory); without it, the whole reachable scope plus the personal domain. `class` filters by kind (`agent-memory` — only memory, `user-doc` — exclude it). Returns ranked snippets with a `score` and `path` (where it lives), not full notes.
- `get_note` — a full note by ref (a note-id from `search`/`recall` or an in-space wiki-ref). Returns the content, frontmatter, `path` (where it lives — for talking to a human in folder terms; reference it by id anyway), `class` (a read-only label for the model), `versionToken` (return it in `edit_note`/`create_note`/`remember_*` for a safe write) and `provenance` (who/how/when edited it). In `detailed` (the default) also: `outline` (the headings — the menu of valid `section` values for `edit_note.replaceSection`) and `links` (the graph edges `outgoing`/`incoming` — for reorg and "what points here"; in v1 `relation` = the graph edge type, not the authored label — that lives in the body, typed edges → #66).
- `recall` — assemble a context bundle under a token budget around a topic: the relevant notes **plus** their graph neighbors (`depth` hops). Richer than `search`. It pulls from knowledge **and** from personal memory. `budgetTokens` bounds the size; `maxPerSource` is the token ceiling for a single note (by default = half the budget: one large note does not eat the whole bundle, the neighbors fit).

**Write / intent**
- `create_note` — create a **new shared (KB) note** in a project: class `user-doc` (visible to the user). `project` — a handle from `get_my_projects`; `body` (Markdown) **titles the note** — its leading `# H1` is the title (#156); `title?` is optional — if set, it wins and strips a duplicating leading `# title` from the body (do not write the title both as a field and as the first line); a note with no title and no first line — a rejection. `path?` — the destination folder: a project-relative folder (`research/arch`) OR a space-relative folder `path` from `list_notes` verbatim (#102 — the server does not double the project prefix); escape hatch — `type?`/`tags?`. **Phase-4 channels:** `links?` — typed edges FROM the note in the same write (`{relation, to}` by id or `{relation, toTitle}` a forward-ref by title, including to a not-yet-created one); `createdAt?` (ISO) — the date of the real event (an import), not of the write moment; `fileName?` — the file name (without `.md`) independent of the title. Additive: a title collision is an error, then `edit_note` — no longer a per-tool guard but the create default every channel now shares ([note-model.md](note-model.md#create-collisions)). The response echoes the derived `title` + `path`/`space`/`outcome`/integrity + `warnings` (e.g. `possible-secret` — non-binding, does not block the write). The agent does **not** choose the class/space (poka-yoke is imposed by the tool). To create **many** notes at once — `create_notes`.
- `remember_about_user` — record a **durable fact about the user** (preferences, context, current work) into their private agent-memory. Append an observation (`observation`) under a `category` (a label, not a path). Optionally `summary` — a one-line category digest for the profile. Not for transient state and not for shared project knowledge.
- `remember_about_project` — record the **agent's private memory ABOUT A PROJECT** (class `agent-memory`, symmetric to `remember_about_user`; **not** shared knowledge — for that use `create_note`). `project` — a handle, `observation` + `category` (a label), optionally `summary`. The agent does **not** choose the class/folder/space (poka-yoke).
- `edit_note` — edit an existing note incrementally (prefer this over a full rewrite). Five word-based addressing modes, **by words, not by positions** (#102 phase 3): `append`/`prepend` (additive), `replace` (the whole body — a full rewrite), `replaceSection` (by a heading; the valid menu — `get_note.outline`), `findReplace` (an exact unique snippet; **an empty `content` = delete the snippet**). **Memory is just a note:** to correct/delete a single fact = `edit_note` by the memory note's id with the same modes (`findReplace` of its text, an empty `content` to remove; or `replace` a category). Return the `versionToken` from `get_note` (CAS) — on a conflict an honest "re-read and retry" error. A live edit echoes the `path` + the result's integrity (`bodyBytes`/`bodyHash`) — to confirm a large edit without a re-read.
- `delete_note` — move a note **to the trash** (#79): the agent's only destructive tool, **reversible by construction** — the deletion is journaled (#12), the note falls into the space's trash, from where the **user** restores it (the agent cannot; restore/purge are human actions; this is exactly the line "the agent does nothing irreversible"). `ref` — a note-id (first `search`/`list_notes`). Works on any reachable note, **including its own agent-memory** (deleted memory is visible in the trash flagged "memory"). To remove **part** of a note — not `delete_note` but `edit_note` (`findReplace` with an empty `content` / `replaceSection`).
- `link` — a typed link `from`→target, `relation` — a short label. The target is **either** `to` (the note-id of an existing note), **or** `toTitle` (a forward-ref by title: link to a not-yet-created note — it resolves automatically once a note with that title appears; a staged migration does not lose edges). An existing target is materialized as the reserved stable-ID envelope plus a readable title alias, so the selected note survives rename and same-title ambiguity; forward references remain human-name links until they resolve. `toTitle` must be non-empty and must survive wikilink normalization unchanged: it cannot start with the reserved `notarium-id:` namespace or end in the storage suffix `.md`, because those spellings cannot denote the eventual human-title note. Both notes in **one** space (cross-space — later, #66). Idempotent by exact case-sensitive ID for existing targets (including a safe upgrade from a legacy plain-ID link to its canonical envelope) and by the shared name key for forward refs; a stale identity envelope never suppresses a distinct human forward reference, and malformed reserved targets compare exactly. To create **many** links at once — `link_many`.

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

- **Order.** `start_session` (optionally with `role`) → retain its `session.id` → pass it to every later tool → page with `list_roles` if role summaries were abbreviated/omitted → when a listed role matches, `use_role` once → survey with `list_notes`/`recent_activity` → `search`/`recall` before writing → `create_note`/`remember_about_*`/`edit_note`/`link`.
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

An episode stores at most one selected role name. `null` is the base mode; there is no synthetic
base role. Selecting a role never changes grants or token scope. `use_role` writes the name only
after resolving it from the effective owned library. A repeated name returns `already_active`, but
still reloads the effective package: the same name may now resolve to a narrower Project/Space fork.
`start_session` also reloads a resumed episode's still-effective saved role, so a fresh model
context is not left with a durable role name but no role instructions. The durable selector is
intentionally the role **name**, not a snapshot of one fork: resolution is repeated against the
project hint of each bootstrap/activation. A session that moves from Project to Personal may
therefore load the same-name Personal fork; callers retain and resend the project handle when the
project-specific role must continue.

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

## Roles and Agent Skills <a id="roles"></a>

The packaged built-in catalog and writable libraries are separate sources. Catalog packages are
read-only discovery templates and never participate in effective resolution. A bounded package is
one valid `<name>/SKILL.md` plus optional `references/`, `scripts/`, and `assets/`; the human `Add`
copies every package member into `.notarium/skills`, recording `notarium.origin` and
`notarium.originRevision` in `SKILL.md`. Auxiliary package members remain byte-identical, while the
manifest is deliberately rewritten with that provenance. The server never executes package scripts. Tool activation
loads only the role and linked-skill instructions; resource delivery to clients remains a separate
progressive-disclosure channel. Complete package bytes are nevertheless present in workspace
`scope=all` export, so a client can download a ready Agent Skill without a converter. Export keeps
the entire owned package byte-for-byte even when note frontmatter stripping is requested. The owned copy
is never overwritten by a later catalog release.

Owned scopes are Personal (private across projects), Space (shared in one space), and Project
(stored under reserved `.notarium/skills/_projects/<encoded-project-id>/`). Same-name precedence is
`Project > Space > Personal`. The first UI slice exposes Add to Personal and Project; Space remains
an effective storage scope but has no separate Add action yet. There is deliberately no mutable
server-global scope.

Role discovery is bounded at both agent and settings surfaces. `start_session.roles` has a separate
1,000-token summary budget and raises `rolesTruncated:true` when summaries were abbreviated,
omitted, or an owned-library bound was reached; continue with paginated `list_roles`. Explicit
activation still resolves any known effective name directly, outside the discovery window, and
loads it through its own budget. The Roles settings response scans at most 128 placements, exposes
at most 128 writable Project choices, and returns at most 512 owned entries, with
`truncated:true` when the bounded view cannot cover the library.

## Security (why the set is exactly this) <a id="security"></a>

- **The trifecta is broken by construction.** `openWorldHint:false` on **all** tools (no outbound channel). No cross-space `link`/copy (internal exfiltration — #66). The agent's destructive action is only **reversible**: `delete_note` sends to the trash (#79, the user restores), the irreversible `purge`/restore are a human (#102 phase 3 replaced the old "no delete" with "the agent does nothing **irreversible**" — this is about breaking the trifecta, not narrowness for its own sake). Container reorg (`move_folder`/`rename_folder`/`rename_project`) — `space:write`; renaming a **space** is not given to an agent (a human action).
- **Scope — on every call.** `tools/list` is filtered by the token's ceiling; `tools/call` additionally checks `can(principal, action, {space})`. A denial = 404 semantics (anti-enumeration), not 403.
- **Untrusted content is defanged on output.** Title/snippet/content/frontmatter are sanitized before being handed to the agent; pseudo-control tags are neutralized. Note content is **never** reflected into tool descriptions / the server `instructions`.
- **Provenance for free.** Every write carries the `principal` (from the PAT) into the journal #12 — per-agent attribution; `get_note`/`recall` can return who edited (human vs agent).
- **Session audit (#243, #321).** Read tools (`search`/`recall`/`get_note`) are logged at the `gateway.callTool` checkpoint **fire-and-forget** (without affecting latency/correctness) — query/scope + the top hits with `score` → the owner-scoped meta-DB facet `agent_retrievals`. When an episode is bound, the row also snapshots its id/name and whether the attachment was declared or inferred. Agent writes keep the same snapshot in the revision journal; there is no parallel write log. These snapshots intentionally survive session-row GC, so Agents → Sessions can show a unified read/write timeline for retained and archived episodes. Activity without a bound episode remains visible under `Outside sessions`. The tool contract does not change — this is server-side observation, not a tool.

## Known v1 limitations <a id="limits"></a>

Fixed by phase: coarse `recall` ranking (hybrid+hop+community; PPR/cross-encoder — later), `link` resolves the target by slug(title) (a durable typed-edge-by-id = #66), cross-space links/recall unavailable (#66), `idempotencyKey` dedup is per principal+tool, vector/hybrid are implemented (#81: a hybrid RRF over FTS5+vec0, degradation to FTS as a capability). #102 phase 2: `get_note.links.relation` = the graph edge type (in v1 the graph is mono-typed `links-to`; the authored label lives in the body, typed edges → #66) — the structure (who links to whom) is exact; `get_note.outline` lists the headings, but `edit_note.replaceSection` addresses the FIRST of same-named ones (duplicate headings are unresolvable in v1) and matches against the raw body (the outline is over the body without frontmatter: they coincide on real notes, diverging only on a pathological YAML-`#`-comment); `list_notes` lists the visible notes (user-doc; for agent-memory — `search`), the `type`/`class` facets and `recent_activity.since` are deferred (a frontmatter-/time-scan of the journal; additive later), the tag filter is exact up to ~1000 direct notes of a folder; `list_notes`/`recent_activity` under a project filter by a label over a window (the journal is not path-indexed — an honest `truncated` on an under-fill, conservative in fan-out). #102 phase 3: `delete` sends to a single trash (notes + memory, marked with `class`); the agent does **not** restore and does **not** purge (a human via UI/REST). Memory is edited like an ordinary note — there is no separate observation addressing by id (deliberately: "memory is just a note", editing with the word-based modes of `edit_note`); `replace` overwrites the whole body (CAS-protected); deleting a snippet (`findReplace` with an empty `content`) heals the seam but multiplies blocks only if the fact itself is multi-line. The `bodyHash` echo on an edit = the hash of the body we wrote (for `replace` the agent reproduces from its own `content`; for the surgical modes — a size confirmation, the engine may strip a leading fm/`# title` on store, as with `create_note`). #102 phase 4: a batch (`create_notes`/`link_many`) is **best-effort, non-transactional** — a failed item does not roll back the rest (`results[].ok/error`, retry only the failures); `create_note.bodyHash` hashes the **sent** `body`, not the final body with inlined `links` (edges are provenance from the gateway, verified via the graph/`get_note`); a forward-ref `toTitle` is materialized as `[[title]]` and resolved by slug(title) once the target appears — **durability on a target rename is given by #100** (the alias history), not by phase 4; `knownValues.relations` is **removed** (the v1 graph is mono-typed, the real relation vocabulary → #66); `warnings:['possible-secret']` is a heuristic on credential patterns (narrow, misses/false positives possible), non-binding; `createdAt` is the date channel (no `modifiedAt`: `modified` is always the real mtime by design). #102 phase 5: `move` takes a **folder** (`toFolder`, not a full path) and keeps the file name — changing the name is `rename`; both operations are within their own space (move is id-addressed, another space is inexpressible; a cross-space move = #66); the destination is cleaned by `safeRelPath` at the gateway (fail-closed: `..`, absolute, the dot-namespace `.notarium` — rejected), and moving an agent-memory note across a mount is rejected by the engine already; `move` does not break inbound links because they are **by title** (a path-form `[[folder/note]]` is rare; the durability of folders on their rename = the #100 phase 3 / phase 6 gate); `rename_note` is link-safe via the alias history (inbound `[[Old Title]]` resolve, bodies are not touched), `versionToken` is not needed (the tool reads the note itself — an internal read+CAS-write catches a parallel edit as a conflict, but does NOT protect against silently overwriting someone's parallel `rename_note`: the old name still goes into an alias then, the links stay intact). #102 phase 6: **name normalization to `verb_entity`** — the note reorg is renamed `move→move_note`/`rename→rename_note`/`delete→delete_note` (aligned with `create_note`/`get_note`/`edit_note`; the only pre-GA breaking rename, serverInfo 0.7.0); the grammar is chosen by an evidence base (an external survey of production MCP + our canon: `verb_entity` dominates, the "bare=note" asymmetry is contraindicated, an action-enum/polymorphic-ref hurt mid-tier models — see the toolset-v2 tool-naming convention). Container reorg: `move_folder`/`rename_folder` — **one engine primitive** `store.move(isDirectory)` (move changes the parent, rename the leaf; there is no separate folder-rename in the engine) + server-side path history (#100 phase 3 `recordFolderRename` + `renamePrefix` for the rows of projects under the folder) — the orchestration is the same as REST `/move-folder`; addressing is **entity-native** (note=id, folder=`path`+a `project?` space-selector, project=handle — a folder-id is lazy/server-side, we do not expose it in listings so as not to breed false uniformity); `rename_project` = an O(1) alias write of the slug (#100 phase 2), `slug?`+`displayName?` (at least one — validated in the handler, not at zod top-level: the transport takes `.shape`), a root project = the space name cannot be renamed (`root`→error), a collision/`not_found` — guiding errors; everything is gated by `space:write`, cross-space is inexpressible by construction, **renaming a space is NOT a tool** (a human action, poka-yoke). #156: **body-first title** (serverInfo 0.8.0, additive) — `create_note`/`create_notes` `title` is now optional (the title = the leading `# H1` of the body; an explicit `title` wins and strips a duplicate leading `# title`), the echo returns the derived `title`; normalization is at a single write checkpoint, so a duplicate h1 does not reach the disk by any path (neither create nor edit/replace). The full decision/review log — the recap comments #21 (v1), #102 (v2), #156 (body-first title).
