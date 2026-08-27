# Notarium Note Domain Model

> Canon of the domain model: note classes, the ontology of names/links, agent-memory, meta-fields, the tags-axis. What the semantic tools of the MCP-gateway (#21) and the surfaces (feed #32, tree #13) hardwire. Code organization (tier/buckets/module form) is a separate canon outside `docs/`. Architectural frame — [manifest P11](architecture.md).

## Note ontology (classes, meta-fields, intent-tool conventions) <a id="note-ontology"></a>

> What the semantic tools of the MCP-gateway (#21) and the surfaces (feed #32, tree #13) hardwire. The class model — [manifest P11](architecture.md#p11) + data-model #74; the tool spec — toolset-v1-spec. A note's identity is `notarium-id` (#51), not its path: move/rename do not change the class and do not break indexes/links. A `[[Title]]` link resolves **id-first → exact raw current path → normalized current name (path/file-name/title) → custom slug → authored alias-history → legacy identity alias-history → folder alias-history** of past names (#100): a rename (title OR slug) writes the old name into the TARGET's `aliases:` (the bodies of the referencing notes are not touched), so incoming `[[Old Title]]`/`[[old-slug]]` continue to resolve. That priority has ONE implementation — `core/referenceResolver` ([core.md](core.md#graph-derivation)) — which graph derivation, the read-model and both engines consume; a client does NOT re-derive it, because its session inventory is partial: `resolveKnownWiki` completes only a stable id it can already prove, and every human name/path/slug/alias goes to `api.noteResolve` → the server's `KnowledgeStore.resolveWikilink`. Exact raw path precedes normalization so legal case/NFC-distinct files resolve the same way in graph derivation and direct reads; a non-exact spelling uses the deterministic normalized collision winner. A note has an editable **slug** (#100 phase 1) — the display/URL axis, decoupled from both the title and the file name (new notes default to `slug(title).md`; an imported, explicit or safely recovered basename stays put until an explicit naming/move intent): it is the addressable resolution key (`[[my-slug]]`) and the canonical URL tail `/n/<id>/<slug>` (a stale/incorrect tail resolves by id and is canonicalized on the client). The collision rule is **current > slug > authored alias > legacy identity alias > folder alias**: a custom slug only fills a free key (it does not shadow someone else's live title) but beats a stale alias. Stored LAZILY — `slug:` is written into the frontmatter only when it differs from `slug(title)` (otherwise the default is implicit). Human-name keying uses core `nameKey`/`namePathKey` in the shared resolver and its engine/read-model consumers; the client only shares wikilink-target normalization before its stable-id fast path — see [Names in any script](#name-alphabet). **Path-form `[[oldpath/note]]` survives a FOLDER rename (#100 phase 3):** a folder acquires a lazy identity on its first rename, the old path goes into its path-history (server-side marker + meta-DB, drag-and-drop.md §8.6), and the resolver registers an `oldpath/…` key (the lowest pass, after current > slug > authored alias > legacy identity alias) — so even an ambiguous file name resolves to the note in the renamed folder rather than to a same-named neighbor. If two folder identities claim the same retired name, the history axis is ambiguous and resolves nothing instead of selecting by list order; stale folder URL redirects use the same fail-closed rule. **Cross-space link (#100 phase 5, primitive):** at the resolution level a cross-space and an intra-space link are indistinguishable — a link to a note is its **global note-id** (a PK without the space in the key; `findById`/`/n/<id>`/`/api/previews` are already global), the space is derived rather than part of the key. The human-readable syntax is **`[[space-slug:Title]]`** (a colon, by analogy with GitLab `group/project#123`; NOT `@` — users read that as addressing someone by nick), `space-slug` resolves via space-alias → `space_id` (#100 phase 4). **Rendering** of cross-space links (and materialization of cross-space edges into the meta-graph) is gated behind a hard security precondition of visibility (anti-enumeration #16) → **#66**; phase 5 fixes only the primitive/syntax, no rendering that bypasses authz is built. **Grooming (#100 phase 5):** during graph derivation each edge gets a `resolvedVia` tag (`current`/`slug`/`note-alias`/`folder-alias`); the metric "N links resolve via a former name" = the count of edges with `resolvedVia ∈ {note-alias, folder-alias}` on a **fresh** derivation (NOT a separate persistent reverse-index — it falls out of the already-running derivation). This is visibility only (the `graph/health` dashboard — the metric + a list of broken links); an optional bulk back-fill of bodies is a separate increment, by default the #100 model does NOT touch the bodies of sources.

An unambiguous plain ID remains a valid authored target. Intent tools use the total
reserved form **`[[notarium-id:<percent-encoded-id>|Readable title]]`**, so an opaque
ID containing `#`, `|`, `]` or ending in `.md` cannot be mistaken for a human name,
fragment, alias separator or storage filename. For an existing target the readable
alias is a display snapshot, never an address: core encodes `&` first, then `[`, `]`,
`<`, `>` as HTML entities. The wikilink parser therefore sees no closing delimiter,
while CommonMark/browser rendering restores the exact title (including `[MCP] Review`)
and navigation still uses the stable id. Forward `toTitle` remains the human-name
grammar and does not gain bracket-title/ghost semantics from this encoding. A miss in
that namespace is a non-creatable tombstone: minting a different note cannot restore
the missing identity.
When a resolved target disappears, the read-model re-derives every cached inbound source
from its body against the post-delete index. A resolved edge is deliberately deduplicated
and cannot remember whether the author wrote a human target, a stable envelope, or both;
guessing from that projection would turn a creatable forward reference into a tombstone.

**Legacy filename compatibility.** Before Unicode-preserving slugs, an imported title could be
stored under the old ASCII-only basename (for example `Қазақстан жоспары` as
`aza-stan-zhospary.md`). That basename is identity evidence, not authored frontmatter: once an
exact observation proves the file belongs to the note, the registry durably unions it into the
note's internal `legacyNameAliases`. The evidence survives later writes, moves, delete/restore and
restart; it is never serialized into `aliases:` or exposed as editable metadata. If an alias write
finishes after identity settlement, it follows the exact durable P→D settlement lineage. An ordinary
tombstone followed by same-path reuse creates no lineage, and resurrecting an id clears its old
outgoing lineage, so compatibility evidence cannot migrate to an unrelated incarnation. Resolution
inserts one compatibility pass after authored note aliases and before folder history. A legacy key resolves
only when exactly one live identity owns it; two owners make the key a ghost, independent of list
order. Current path/name, custom slug and authored aliases therefore keep their existing priority
and cannot be shadowed by compatibility data.

### Outward terminology
`space` (domain, boundary #16) is an internal addressing term, NOT exposed outward to the agent; the personal domain is implied from the PAT. The one descriptive exception is an effective role summary with `scope: 'space'`: it reports why that owned role won, but carries no space selector and cannot choose placement or access. **`project`** outward = the real addressable unit of work INSIDE a space (a marked folder-entity with the `.notariummeta` marker, #13), NOT a space. The handle = `(space, slug)` (the GitLab `group/project` model: `slug` is unique within a space, same-naming across spaces is disambiguated by the `space` field; the stable `id` is globally unique). The agent addresses a project by handle plus a project-relative folder or an exact space-relative folder copied from `list_notes`; a duplicated handle prefix on a non-root project is rejected, while root grammar is intentionally collapsed. The space is resolved behind the handle; the agent does NOT choose the space/class (poka-yoke). The model canon — [projects.md](projects.md). _(The former "outward-`project` = working space" and the double meaning of the term are canceled by #13: spaces stopped being called "project", real project-entities appeared; a reversal of #74-F3.)_

### Classes and where intent-tools write <a id="note-classes"></a>
| Class | Visibility | Who writes | Convention |
|---|---|---|---|
| `user-doc` | tree/feed/search, freely organized by the user | user (UI) + `create_note` | default `type` + the project folder by handle; escape `path?`/`type?`/`tags?` |
| `agent-memory` | personal domain + a project subdirectory (#13), as a separate section | `remember_about_user` + `remember_about_project` (memory about the user/project) | `category` → category-file; frontmatter `summary` → derived-index |
| `profile` (#159) | HIDDEN from ALL discovery surfaces (tree/graph/feed/search); access only via Settings → Profile + the agent's `start_session` (by id) | `PUT /api/me/profile` (the user writes about themselves) | a singleton in the `.notarium/profile` mount; `type:person`, the `always-load` tag; human content, NOT agent memory (provenance — the user) |
| `skill` (#307/#309) | hidden from generic tree/graph/feed/search/recall; visible through Agents → Abilities and role resolution | human Add/New Role/Skill and exact Ability routes; MCP `create_ability`/`edit_ability`, while RC `delete_ability` accepts only a single regular direct `SKILL.md` package | valid ID-backed Agent Skills packages in `.notarium/skills`; roles may live in Personal/Space/Project libraries, while skills have only Personal/Space homes and Space availability lives in the meta-DB; Markdown members participate in current note versioning/replication, while auxiliary bytes are retained verbatim and included in `scope=all` export/data backup but remain outside the note journal; human multi-file delete is unchanged, and atomic agent batch tombstones are POST-RC |

Generic MCP note/link/context doors never address `skill`; human REST metadata/preview and the
compatibility note write keep their existing access. The transport policy protects package
integrity and typed authoring, not a stronger credential boundary.

RC agent deletion is intentionally stricter than the package model: `delete_ability` refuses any
auxiliary member and requires the sole root tombstone before detached bytes are destroyed. This is
a temporary recovery constraint, not a claim that Agent Skills packages are single-file; the human
door still handles full packages, and agent multi-file deletion waits for atomic batch tombstones.

**The write-intent trio (#13)** — the agent does **not choose** the class/folder/space (poka-yoke), the tool imposes it:
- `create_note` → class `user-doc` (knowledge into the project tree by handle `(space, slug)` + project-relative or exact space-relative `path`; a resolvable duplicated handle prefix is rejected for non-root projects);
- `remember_about_user` → class `agent-memory` in the personal domain (memory about the user);
- `remember_about_project` → class `agent-memory` in the agent-mount subdirectory `.notarium/memory/<id>/` (memory about the project; writing is symmetric to `remember_about_user`, reading is space-membership-scoped, not self:read).

_(#13, 2026-06-17: the name `remember_about_project` was RECLAIMED for memory; the former KB-write → `create_note`. The model — [projects.md](projects.md).)_

### Roles and skills <a id="roles-and-skills"></a>

A skill is a portable, bounded Agent Skills package: `<note-id>/SKILL.md` plus optional
`scripts/`, `references/`, and `assets/`. The package directory is immutable storage identity;
the manifest `name` is editable discovery metadata. Add copies every member:
auxiliary files remain byte-identical, while `SKILL.md` is rewritten with the same `notarium-id`
and immutable Catalog provenance. The server never executes scripts, and role activation
progressively loads only the Markdown instructions. A role is the same valid package with
`metadata.notarium.kind: role`. Every package has one source: `System`, `Catalog`, or `Owned`.
System packages are immutable, effective by default, and use exact System dependency locators.
Catalog packages are immutable templates only: they are neither effective nor toggleable.
Catalog templates link supporting packages by wiki name; Add rewrites those links to Owned
locators carrying placement + exact package id + a readable label. The label is never a lookup
key. Copying records origin and catalog revision, but produces an independent Owned fork: no
Catalog update overwrites it.
Agents → Abilities exposes exact read-only System, Catalog and Owned detail routes: the complete
instructions and, for roles, the supporting skills loaded with them. The central Roles/Skills
libraries are owner-global and searchable; the Agents Explorer is a separate current-Space
projection grouped by System, Personal, Space, Project (Roles only), and Catalog. A Project group
holds only roles that have no Space base — a version never forms a group, because it is not a role
of its own. Home,
availability, and project remain server-side facets. An Owned package opens through
`/agents/abilities/<roles|skills>/owned/:locator`; System and Catalog use their source-specific
package-id routes. New authoring lives at `/agents/abilities/<roles|skills>/new/<draft-id>` and
publishes before replacing that URL with the returned exact Owned route. Subsequent Owned edits use
`PUT /api/me/agent-abilities/:locator/save`: one application producer applies the manifest document
under note CAS, then the placement-owned `home`/availability state, and returns the current locator,
version token and per-step outcome. The generic `POST /api/note` ability arm calls the same authored
document producer; it is not a parallel serializer. The ability surface omits generic note metadata
and changes only manifest identity, instructions, and (for Roles) the authored attachment list.
A strict Owned capture first holds the root note's exact id/path claim and only then reads the physical
manifest under package admission. It returns one immutable registry id/path/version plus manifest
owner/package snapshot and releases both scopes before access, detail, and dependency work. Every
document, enabled, availability, or move mutation reopens that captured dual identity in the same
`note → placement/package` order; no package-admitted callback reads the note projection. A semantic
document no-op still performs this fresh proof but writes neither package bytes nor a note revision;
explicit `home`/availability/enabled steps requested in the same compound operation remain separate
fresh steps with their existing partial-result order. A physical placement move hands the admitted
manifest claim to the adapter at its original source path; the adapter binds that resource to the
directory transition and returns a fresh target-scoped proof for finalize/rollback. Callers never
compare an opaque claim across paths, and an external source replacement is reported unavailable.
Initial exact capture resolves the package through the cached class metadata projection; it does not
materialize sibling bodies. After that registry id is known, the document path observes only the exact
note and its own manifest — that part does not grow with the library. Two axes around it still do, and
neither is claimed to be constant: the locator-to-registry projection above, and the placement-wide name
check every package write performs, which reads the neighbouring manifests to answer whether a name is
free. Both are reported as measured numbers rather than asserted away. Because `skill` is graph-hidden,
an authored edit emits no graph transition and preserves the warm graph-health derivation revision.
A generic note/history/trash reference remains `/n/<note-id>`—there is no
parallel `/skill` resolver. Create and Add return only
after the common note projection can read the returned exact id, so immediate navigation cannot
land on a transient 404. Hidden package notes never enter the generic explorer tree, favorites, or
mount-path breadcrumbs. The list description remains discovery metadata; it is not a substitute
for the package body. In Trash, a package root keeps its manifest name even when its authored body
has no heading; single and bulk restore use that same package-aware Trash projection.

That human URL/REST read-model reuse does not make an ability package a generic MCP note. Direct
MCP note lifecycle and graph-link tools reject an accessible package root and point to the Ability
tools; access is checked before the class refusal. The ordinary REST note write remains open and
uses the same authored-document producer as the exact Ability save route. A physical skill root
whose typed projection is malformed remains repairable there with a body/description CAS write;
changing its typed attachment list still refuses until the projection is valid. This split protects the
typed agent door and whole-package lifecycle; it is not a stronger credential boundary.

Roles retain Personal/Space/Project placement and effective name precedence
`Owned Project > Owned Space > Owned Personal > System`; package members and persisted Owned/System
links never resolve a target by name. Catalog never participates in effective resolution.
Skills instead have one identity in a Personal or Space home. Personal is private and available
across the owner's project contexts. Every Space-homed ABILITY — role or skill — has one durable
availability policy: `all-projects` or a set of stable project-id bindings. A selected-project
ability can therefore be effective in A and B but absent in C without copying or forking its
package, which is what a role needed in two projects out of five has instead of a second copy.
An absent policy row is read per kind: a Space skill defaults to nothing selected (a dependency is
opted into), a Space role to `all-projects` (that is what a Space role meant before the policy
existed, so the setting arrives with no data migration). Availability only ever decides inside a
project context: outside one a Space ability is not a candidate at all, and Personal has no
projects to select from. Project-owned skill packages are not a compatibility path. Public ability locators carry source + kind + immutable
package id; an Owned locator additionally carries stable space id and, for Project roles, stable
project id.

A Project role is a VERSION of the role its Space base shares a name with, not a second role.
Listings therefore collapse the pair into one entry: the base carries the identity and the versions
hang off it as `{ projectId, locator }`, counted once in `filteredTotal` and reachable by their own
exact locator. A version overrides its base inside its project and is self-sufficient there — it
was created by an explicit act for that project, so the base's availability is not a permission it
asks for. A project role with NO base of that name is not a version of anything: it is an independent role that happens to share a name across projects, so each stays its own entry named by the project it lives in — collapsing those would have to elect an arbitrary one to stand for the rest and would hide the others. Two
operations replace copying: fork a base into a project version (same name, the base's body and
attachments as a starting point, its own package address), and RELOCATE a project role up to the
Space home of the space it already lives in. Only the first is an action, because it creates
something. The fork copies one identity-bound snapshot captured under the source package's
registry/manifest authority; destination admission never reopens the source address, so a package
that later occupies it cannot become the version. The second is not a command at all: where a role's package sits follows from how far it
reaches, and covering anything other than exactly its own project is something only a Space home can
do — so a project role given a wider reach relocates on the way through the document's ordinary save.
Up is the ONE direction the model has. The request carries a single destination (`{ scope: 'space' }`,
so no other target is expressible), and the service — not the route — refuses everything else, from
one reading of the locator: a placement that is not a project one has nothing above it, and a
personal space has no Space root to be lifted into, because there Personal and the Space root are
one directory. There is no Space → project and no
project → project relocation, and a skill, having no project placement, has nothing to relocate. It
is refused before anything moves when the destination name is taken, which is exactly the case of a
version whose base carries that name above it: a base and its version may share a name only while
they sit in different placements, and neither merging nor overwriting is an answer the user could
have meant. The package directory moves inside the same Space, so the package address survives it —
and because placement is part of a role's address, so must every durable pointer keyed by it: the
context target `(scope, owner id, package id)`, the owner's `(owner, locator)` preference row and a
live episode's `role_locator` move in one meta-DB transaction. The role keeps exactly the reach it
had — the one project it served, written as that single selection, never the Space-wide default,
because a relocation must not widen what a role applies to. If the pointer transaction fails the
package is put back and the previous reach restored — but only together: reach describes where the
package IS, so undoing it while the package could not be returned would leave a role standing at the
Space root with an absent reach row, which READS as all-projects. A failed relocation must not widen
what a role applies to any more than a successful one may. Personal ↔ Space is deliberately not offered: it is a move between spaces, which the note
engine has no operation for. When it arrives it must also carry the availability row and re-ask the
reach, since project ids do not survive the crossing.

Role health is a fact about a (role, project) pair, not about a role: an attachment that a Space
skill's availability withholds from project B leaves the role healthy in A and unhealthy in B, and
an unhealthy role fails closed at activation there. Persisted role attachments retain their exact System/Owned token, authored order, and
duplicates. Malformed exact-looking tokens remain visible as `invalid-locator` rather than
disappearing. An ordinary manifest/instructions save leaves the attachment metadata entry
untouched; a changed attachment list is validated against the exact Role placement and replaces
only `metadata.notarium.skills` inside the same CAS write. Existing malformed raw tokens may be
preserved or explicitly detached but never newly introduced. Role health classifies each
attachment as `healthy`, `missing`, `disabled`,
`unavailable`, `invalid-locator`, or `wrong-kind`; an enabled unhealthy Owned role blocks lower
same-name fallbacks and cannot activate.

System and Owned enabled state is an owner-scoped sparse override in the meta-DB: absence means
enabled and a row means disabled. Disabling a more-specific Owned role reveals the next enabled
fallback; Catalog has no preference row. The human toggle needs a readable exact package, not a
writer grant, because it changes only that owner's preference. Agent `edit_ability` remains an
authoring door and requires both a write-ceiling credential and a writer grant. Owned overrides survive a reversible soft delete, then
are removed with permanent note or Space purge. The one role selected in a durable agent episode is
separately called active. No selection means base mode, not a synthetic base role.
An active named episode fork inherits its parent's selected role; a brand-new episode starts in
base mode. The episode stores both the public name and its exact placement/package pair. Hydration
in the same project context reopens that exact package across rename. A changed project context or
missing exact package degrades to base mode instead of rebinding by name to a same-name replacement.

Each owned role placement may also carry a context preset: ordered pins and context sets stored in
the meta-DB against `(placement scope, stable owner id, role package id)`. The preset belongs to the owned
copy; a catalog template has none and is never effective before Add. Same-name Personal, Space, and
Project copies therefore keep independent presets, and the exact placement selected for the role
body selects the preset too. The Context UI previews and mutates this preset by the encoded exact
Owned Role locator; names are labels only and cannot rebind a stale bookmark to a same-name copy.
At session load it is the most-specific layer under the existing
Personal/Project budget (`Role → Project → Personal`), not a separate allowance. It adds no grants
and no role-scoped memory, delta, or index. Without a meta-DB the file-first role package and its
instructions still work; only the preset and durable session selection degrade away (P5).
Generic context metadata may contain a direct ability-package note id (the REST editor keeps its
exact authored view), but the MCP projection omits only that `class: skill` item. The containing set
and every ordinary note item remain; no extra diagnostic field is added to the agent wire.

### agent-memory: structure and behavior <a id="agent-memory"></a>
- **File-per-category, not file-per-observation** (against micro-files): `remember_about_user(observation, category)` appends into the category file; new categories = new files.
- **The index is derived (P11/P13)**: assembled by us from the `summary` frontmatter-field of each memory file; not edited by hand; rebuilt by a full-rescan (#69, P2). The read-model keeps the small `title/summary/snippet/muted/bodyTokens` projection warm from bytes its identity sweep already reads, so `start_session` and the Context UI do not reopen every category; a missing accelerator/fact falls back per file. eager (the index is loaded into the `start_session` bundle) / lazy (the files themselves are pulled in by `recall`).
- **Visibility** (refines #74, where `agent-memory` had `tree/feed/userSearch=✗`): memory **is visible** in the personal domain, but as a separate section with its own semantics. The user **reads / edits the content / deletes** (audit and control over what an injection could have slipped in — provenance from journal #12), but does **not reorganize** (the section is owned by the agent; a flat set + a derived-index, no user folders). Move is safe (identity on note-id, the index is rebuildable) — so the ban on reorganization is a product decision, not a technical one.
- **A separate mount, dot-namespace** (materialized #78): agent-memory is a typed mount in the same space, physically at `.notarium/memory/` (the system default; a per-space setting may override). The dot-namespace is collision-safe against user folder names (analogous to `.git`/`.obsidian`) and itself falls out of the notes-mount scan (localfs skips dot-directories), so the mounts are non-overlapping without separate logic. It is reserved for all Notarium-managed truth of the space (chat #75 — alongside, `.notarium/chat`); the regenerable derived-index is NOT placed there (app-data, not replicated). The class is **derived from the mount (enforced)** — the agent chooses neither the folder nor the class.
- **One index with a `class` column** (#78, not index-per-class): the engine stamps `class` from the mount onto every row; the visibility checkpoint is single in the read-model (`CachedStore`), not a default `WHERE` in every query. Sliced by `ReadScope`: the default `user` (surfaces hide agent-memory), `agentRecall` (#21) mixes memory in, `all` — sync/inventory. A semantic operation that already addresses one class may additionally pass `classes` as candidate narrowing: the engine pushes it into `idx_notes_class`, then `CachedStore` still intersects the result with `ReadScope` (optimization, never a visibility bypass). Thus the derived memory index enumerates and reads only `agent-memory` rows; its cost follows the memory mount, not the ordinary-note corpus. A read of a graph-invisible class also never derives or patches user-graph edges: wikilinks inside memory remain inert instead of rebuilding the visible corpus's link index. Direct read by id is NOT scoped (the user owns their own memory).
- **Filtering by meta** (`kind`/`class`): feed #32 and the tree can hide/show memory — a special case of the "surface × class" matrix #74 + user control.
- **Human audit order (#314).** Personal and project Memory categories expose both nullable `createdAt` and `modifiedAt` and follow the explorer's one global Name/Created/Modified + Ascending/Descending preference. This changes only the audit projection: omitted REST query remains newest-write-first, while `order=eager` preserves the derived-index order used by context construction and wins over display sorting.
- **The `chat` class** (#75) is not included in `recall` v1 (the injection surface of dialogs).
- **Concurrent appends into one category converge** (#341): an append is serialized on the category's durable identity — its name key (`nameKey`, the axis the lookup MATCHES on, not the one the file is named on) plus its partition (the about-user root vs `<project-id>/`) — across the whole find-or-create-append window, not merely the store write inside it. Different categories and different partitions stay parallel. The task's self-token writers inside that fence are `remember_about_user` / `remember_about_project` and the mute toggle; a remember call carrying a caller token still takes the fence so its fail-fast check and write are atomic. Outside it, answering an honest conflict: `edit_note` **with** a caller token and the REST update — fail-fast by contract, the token's owner is the client; and, as a **known boundary rather than a guarantee**, `edit_note` **without** a token, `link`/`link_many` and `rename_note`, which also write under a self-read token but are not fenced. Against writers outside, a lost CAS is retried only while somebody is actually committing (a bounded budget); exhausting it answers `memory_convergence_exhausted` — a distinct reason, because the caller never held a token and so cannot act on "re-read and retry". A file edited behind our back is a third failure, not a conflict: it surfaces as `# Write Failed` (index desync), is cured by reconciliation and is deliberately not retried. The guarantee is per-process, like every fence here ([core.md](core.md)).

### Note meta-fields
- `notarium-id` — identity (#51), in the frontmatter (P7).
- `notarium-source` — reserved source-addressable import provenance. It is logical/file state (therefore part of CAS/history/restore/export), not a `StorageOwnerKey` and not public/authored metadata. `NoteMeta`/`NoteContent` carry an internal typed `sourceLocator`; ordinary REST/MCP/frontmatter projections omit it. A canonical direct external field is file truth, while fresh Markdown/public/inline carry is stripped. The derived index projects it into nullable `source_locator` without backfilling unchanged legacy rows.
- `kind`/`class` — the note's class (`user-doc` / `agent-memory` / …); the single point of surface filtering (a policy invariant, not a bypassable `WHERE` — #74 §2).
- `summary` — on `agent-memory` files; feeds the derived memory-index. Write semantics (#102): a `summary` passed to `remember_*` **overwrites** the previous one, an omitted one is **carry-forward** (the previous is kept); the response carries `summaryUpdated` (true = overwritten, false = kept) — there is no silent loss.
- `type`, `tags` — the `user-doc` ontology (escape-parameters of `create_note`); `path` is normalized, `..`/absolute paths are rejected.
- always-load — **scoped** `(scope, tag)`, not a flat global tag: user-level is always loaded, project-level — only on a hint (#22, bootstrap §2).

#### Tags as a navigation axis (#109)
A tag is a **navigation axis**, not just a string in the frontmatter. The canonical normalization function is `core/libs/tags` `foldTag` (one across all engines and the client, like `slugify`): **case-insensitive** (`ML`/`ml`/`Ml` — one tag) and **hierarchical** by `/` (segments are trim+lowercase, empties collapse: `Work / Projects` ≡ `work/projects`). Folding happens **only on read/match** — the frontmatter is not rewritten (the original case is stored and shown in the chip; the resolution/grouping key is the folded one). The match is **hierarchical** (`noteHasTag`): a query for the parent `ml` catches descendants `ml/nlp`, `ml/nlp/bert` (a subtree cascade, like folders), but NOT a same-named tag across a segment boundary (`ml` ≠ `mlops`). Where the axis lives: **the read-model snapshot** — the engine returns `tags` on `NoteMeta` (the `notes.tags` column already existed, is FTS-indexed for full-text; for navigation it is NOT an engine table), so the window/histogram/facet/graph are computed over the snapshot under the single visibility checkpoint #78 (agent-memory tags are not exposed on the default surface). The filter (`NotesQuery.tags`) is **OR/union** over the set (the unified model "you added a value → you see more", the same as the folder facet; within a facet it's OR, between facets folder ∧ tag is AND), the contract is an array (a repeatable query-key), the UI multi-selects tags. A future "narrow"/AND mode — a UI toggle over the same array. The `GET /api/s/:space/tags` facet returns a tree of nodes (a flat list of paths+counts, the client nests them like folders) — `count` = subtree population, `direct` = exactly this tag; the shaper is shared — `core/libs/tags` `buildTagFacet` (the same one on the server and in the graph on the client). **The axis UI (feed+graph unified):** the tag-facet = **hierarchical chips + search + top-N** (NOT a tree — on a real base it's too long; NOT a flat cloud — it loses the hierarchy). The interaction model is **inclusion** (as in the whole application): by default nothing is selected, a click on a chip adds a tag (highlighted in accent), a parent chip `▾` expands its children below the cloud, the header × resets; the active filter is read in the aside, **no chips above the content**. On a note's page tags = neutral chips (ready for a per-tag color), clickable → `?tag=`. The canon — recap #109.

## Names in any script <a id="name-alphabet"></a>

A name is TWO things at once — the file on disk and the key `[[wikilinks]]` resolve
against — and both come out of core `slugify`. So what that function drops, the product
loses. It romanises Latin (incl. accents), the full Cyrillic block and Greek; a script
it has no romaniser for (CJK, Japanese, Hebrew, Arabic, Thai, Hangul) **keeps its own
letters** rather than being dropped, and the result is recomposed to NFC.

Dropping them was a data-loss bug (#296), not a cosmetic one. An empty slug made the
path `<dir>/.md` — a dot-file the scan skips, so the file lived on while the note read
as externally deleted after the next boot; every such title aimed at that ONE path, so
a second one was refused as a duplicate of a visibly different note; and every such
`[[label]]` shared the one empty resolve key, so the whole non-Latin corpus resolved as
one arbitrary note or merged into a single ghost.

Combining marks survive, because in Thai, Hebrew and Devanagari they carry the vowels —
but a **variation selector** does not: it is a mark by category that names nothing, and
keeping it made `❤️` slug to the single invisible U+FE0F, so the note took a file whose
whole name was zero-width and the entire emoji family shared one key. An orphan mark is
dropped for the same reason: once the punctuation/emoji base of `#️⃣` or `*️⃣` is gone,
the surviving U+20E3 names nothing and must not become their shared invisible key. VS17+ selects a
CJK glyph variant; dropping it leaves the base ideograph, which is what a name key
wants anyway — two visually identical ideographs must not take two keys.

**Two axes, and a key on top of them.** `slugify` is the NAME axis for values that must
BE a slug: the file name, the URL tail, a heading anchor. `asciiSlug` is the HANDLE axis
— a space or project handle, a URL segment pinned to `[a-z0-9_-]` by `SpaceSlugSchema`:
it romanises what it can and returns `''` otherwise, and the caller falls back to an
id-shaped handle (`idToSlug`) soft-suffixed by `uniqueSlug` ([spaces.md](spaces.md),
#123). The plain name is the SAFE default deliberately: a slip on the handle axis is
caught by the schema, a slip on the name axis silently loses a note.

**Matching two NAMES is a third thing, and it has its own key: `nameKey`** — the slug,
or the raw NFC case-folded form when nothing slugs. Canonically equivalent spellings and
non-ASCII case variants therefore meet without changing the storage filename; ASCII
camelCase boundaries are preserved before folding so `BookStack` still matches `Book Stack`.
`[[🎉🎉]]` is a name a human writes and a
note can answer to, so a surface that keys it on the bare slug loses a note the others
can reach. Its path form `namePathKey` applies it per segment and is EMPTY when the LAST
segment names nothing — `journal/` (what a legacy `<dir>/.md` file slugs to) is not a
name, and registering it would hand that note the key of its own FOLDER.

Every surface that matches names calls those two: the shared reference resolver's link
index and `resolveLink` (`core/referenceResolver`), both engines' direct-read fallbacks,
the read-model's snapshot filter, alias history, the client's stale-folder redirect,
memory-category lookup and typed-link idempotency check.

A literal storage key and a human wikilink are separate boundary types even though both
arrive as strings. An engine first honors an exact opaque id or an exact full `filePath`
returned by `list()`; only then does its human resolver normalize alias text, heading
fragments and `.md`. The space-scoped HTTP `note?ref=` route is explicitly the wikilink
channel and normalizes before calling `KnowledgeStore.resolveWikilink`; the production
read-model selects the winner through `core/referenceResolver` and reads it by stable id.
Internal inventory/body reads pass the literal full path. Thus a legal external
`Foo#section.md` remains readable as storage, but
`[[Foo#section]]` and `[[Foo#section.md]]` navigate to `Foo.md` on every product surface.

A surface that keys a LINK LABEL rather than a note's own name takes a third form,
`linkKey` — `namePathKey`, or the raw label when even that is empty. It exists because
neither key alone is total for a label: `namePathKey` is empty for `journal/` by design,
and `nameKey` flattens the path, so either one alone merges labels the resolver sends to
different notes. Its callers are `resolveLink`'s ghost target and the typed-link
idempotency check — where a merge is silent data loss, since the second
`link` call reports the edge as already present and never writes it.

**`linkKey` is an IDENTITY, never a LOOKUP key**, and that distinction is the whole of
it. A label is looked up under `namePathKey`, and a label that key empties is not looked
up at all — `journal/` names nothing, so there is nothing to find. `linkKey` answers the
next question instead: this label found nothing, so WHICH missing note is it? Using it to
search is not a harmless superset. A note titled `!/` registers the index key `!/` through
`nameKey`'s raw rung, so a resolver that searches under `linkKey` finds it while one that
searches under `namePathKey` does not — and the fake did exactly that, showing a healthy
link for a link the shipped engine shows as broken.

The ghost carries a **prefill that must key back to the ghost's own last segment**, or a
note created from it re-ghosts and the reader offers to create it again, forever. The
de-kebab that makes `dir/missing-note` read as "Missing Note" mangles a segment kept raw
(`🎉-🚀` → `🎉 🚀`, which keys elsewhere), so the rule is asserted rather than approximated:
de-kebab when it round-trips, else the label's own last segment, which satisfies it by
construction. The exception is a missing stable-ID envelope: it is an explicit
non-creatable ghost (`creatable:false`), because a newly minted ID cannot close it.
Ghost node ids are synthetic graph keys, not a reserved subset of opaque note ids. If
the usual `ghost:<target>` spelling is already a real note id, graph shaping assigns the
ghost a deterministic collision-free key and rewrites only the derived edge. Derived
edges retain unresolved-target provenance until shaping, so a stable edge to that real
opaque id and an unresolved human edge are not deduplicated merely because their raw
target strings coincide.

**The file name formula** is one function — `noteFileBase` — shared by both engines,
the read-model's path fence and any capability-backed boot heal, so no two of them can predict a
different destination for one write. Its rungs, in order: an explicit `fileName`
(import #11, a folder page's `index`), else the title's slug, else — when the title has
no letters at all (emoji, punctuation) — an id-derived handle, which is why the id is
settled BEFORE the path is predicted for such a create.

A TITLE-derived name is clipped to a UTF-8 BYTE budget (a limit in characters would
pass a CJK title that `ENAMETOOLONG`s), set at what genuinely does not fit rather than
at a round number — clipping earlier would rename a pre-existing long title's file on
its next save. A clipped name carries a 96-bit SHA-256 tag derived from the WHOLE slug,
because a clip cuts the TAIL and the tail is where every distinguishing suffix lives:
without the tag, `<title> 2` and `<title> copy` fold back onto the clipped name, so
`uniquify` and Duplicate would have nowhere to land and two different long titles could
not share a folder. An ordinary explicit `fileName` is protected by the same final bound: it is
host-internal, but still reaches the filesystem and therefore cannot bypass its
255-byte component limit. Any overlong basename is clipped and receives a hash of the
WHOLE requested name, preserving distinct importer identities and uniquify suffixes.
The maximum basename is 252 UTF-8 bytes, leaving exactly three bytes for `.md`; a valid
252-byte existing name is not renamed early. The importer is the narrow exception:
its provenance-gated filename retains the frozen pre-portability spelling, while its
parser already owns the historical size caps. This preserves old POSIX `con.md`/`nul.md`
imports without exposing device names through any public write surface
([import.md](import.md#file-names)). Only the FILE name is clipped — the resolve key
keeps the whole title.

Agent-memory category files use the same 96-bit tag for a letterless category and for
an overlong clipped category. Find-or-append writers must converge on one deterministic
path per name key, but a 32-bit tag made two distinct valid categories permanently
contend for that path.

A slug is a **case-insensitive** key, so the fold runs after transliteration as well as
before it: NFKD expands the compatibility block into uppercase Latin (`㎒`→`MHz`), which
must not become a second key for a name a case-insensitive filesystem already treats as
one.

Filesystem portability falls out of the alphabet rather than a ban-list: `< > : " / \ |
? *`, control characters, the dot and the space are none of letter/digit/mark/underscore,
so a name can neither escape its directory nor grow a second extension. Combining marks
ARE kept — in Thai, Hebrew and Devanagari they carry the vowels, so stripping them like
a Latin diacritic would mangle the word rather than romanise it.

**Legacy files are recovered on boot without gambling their bytes.** Exactly `<dir>/.md`
is included in the scan when its frontmatter carries `notarium-id`, so reconciliation
re-adopts the old stable identity instead of producing a tombstone; arbitrary idless
`.md` and every `.anything.md` remain hidden. Automatic migration onto the current name
is allowed only when the storage adapter advertises an atomic no-replace destination
claim; a collision then continues through the bounded `-2`, `-3`, … series. LocalFS
keeps a private hardlink to the source inode. A pure rename publishes that exact inode,
preserving its mode, timestamps and extended attributes; a rename-plus-edit publishes
the complete final bytes from a separate operation-owned file. It removes the public source only after moving
that pathname into private staging and checking both its inode and the bytes the caller
read. A racing replacement or in-place edit is restored rather than unlinked. Rollback
likewise removes the published destination only while its inode **and final bytes** are
still the operation's; a peer's atomic replacement or in-place edit wins. A note rename
therefore never claims old bytes and follows with an overwrite. An ordinary content save preserves
the basename because it carries no move intent. The same no-intent rule preserves
deterministic imported basenames; only an explicit title/folder/fileName change requests
a move.

The operation claim is persistent under `.notarium-fs-ops`, not merely an in-memory
rollback. `preparing` permits no public mutation; `active` is the recovery intent; `done`
makes private cleanup retryable. Every read/scan/mutation first recovers an active intent,
and recovery accepts only canonical in-root paths outside its own namespace. Real child-
process exits exercise every publication/detach window. This is process-crash recovery in
the current single-writer, same-filesystem topology, not a power-loss/fsync guarantee; a
future multi-process deployment needs the distributed/storage lease described in
[core.md](core.md#write-through).

## Create collisions: a name is taken <a id="create-collisions"></a>

A note's storage path is derived, not chosen: `slug(title).md` inside its folder, one formula
shared by every engine (its alphabet and its id fallback: [Names in any script](#name-alphabet)). So two creates of the same title in one folder aim at the same file —
and for a long time the second one simply won, silently. The write was a `createOrReplace`
wearing a `create`'s name: the victim's body was gone from the live note, and — because the id
is bound to the path — the newcomer also inherited its `notarium-id`, and with it the URL,
the inbound links, the favorites, the pins and the creation date. Only the channels that had
remembered to opt into a guard were safe.

**The default is now refuse.** `WriteInput.ifExists` names the policy and applies to creates
only (an edit is id-addressed and CAS-proven, and rename-onto-occupied has always been fenced
in the engines):

| policy | what it does | who asks for it |
|---|---|---|
| `fail` (**default**) | throws `noteAlreadyExists` | everything, by simply not asking |
| `uniquify` | lands beside the occupant as `<title> 2`, `3`, … | Duplicate, and the editor's "save under a free name" |
| `overwrite` | upserts onto the occupied path | **import only** — and it is not on the wire |

`overwrite` is deliberately absent from `CreateNoteRequest`: replacing another note's bytes is
a host-internal capability, so no client can reach it however it composes a request. It remains
only on path-based import branches (Markdown trees and memory formats). Source-addressable
Claude/ChatGPT records do not overwrite by path: they update the unique `notarium-source`
owner by id+CAS, or create at a guarded canonical path
([import.md](import.md#idempotency-dedup-on-re-import)).

**The fence is the PATH, not the title** — the path is what would be clobbered. A title is
still not unique in a folder, and deliberately so: a note whose basename diverges from
`slug(title)` — an imported file keyed by source-id, a note created outside Notarium, a
`fileName`-pinned write — does not collide with a same-titled newcomer, and the two live
side by side. Which one an ambiguous `[[Title]]` resolves to is the resolver's question
(current > slug > alias, above), not this one.

**Two layers refuse, and they see different things.** The read-model checks its snapshot and
knows the occupant's identity, so the error carries `existing` (id + title + path) and the UI
can offer "open that one". The engine checks **disk truth** underneath, which also catches a
file the index has never seen — there the occupant has no identity to name and `existing` is
absent, so the affordance honestly disappears ([P5](architecture.md#p5)) rather than guessing.
For LocalFS the final create is a filesystem-atomic no-replace publication of complete bytes,
not a check followed by an overwrite-capable rename; a file, directory, or dangling symlink
that owns the pathname wins the race and is never replaced. `overwrite` deliberately uses the
ordinary replace path.

A rename onto a pathname that disk reports occupied is allowed only when the adapter can
prove both spellings are the same directory entry through the filesystem's canonical path
(the case/NFC-only rename on an insensitive medium). Matching device/inode alone is not
proof: two distinct hardlink names share them, and a POSIX rename between those names is a
no-op that would leave the old note behind. Symlinks and hardlink aliases are therefore
occupants, not alternate spellings of the source.

Directory moves use the same no-replace rule, through the one primitive the engine exposes
for it. On the supported Linux runtime that primitive calls `renameat2(RENAME_NOREPLACE)`
directly rather than through GNU `mv -n`, whose portability layer may fall back to a raceable
check-then-rename; source and destination parent are verified on one filesystem so no copy
fallback is possible.

**A runtime that cannot perform it does not advertise it.** The engine resolves the
primitive once — Linux, a mapped syscall ABI, and `/usr/bin/perl` present as a regular
executable file — and an adapter built where any of those is false carries no
`directoryNoReplaceMove` capability at all. So a caller learns the truth from the shape,
before the first filesystem mutation, instead of from an `ENOTSUP` thrown mid-operation:
`NotariumStore.move` refuses a folder move up front, and the role library hands out no
publication writer at all — so an install is refused before a root is prepared, stale
staging is swept or a single package byte is written. Nothing emulates the primitive with a
check-then-rename approximation on that branch.

**Three contracts rest on that one runtime fact, and they stand or fall together.** Moving a
directory, installing a package directory and staging a strict publication all land by
renaming onto an absent pathname, so an adapter built without the primitive declares none of
`directoryNoReplaceMove`, `packagePublication` or `strictPublication`. They stay separate
capabilities because they are separate promises — a different medium could offer one and not
another — but on this adapter they are derived from a single captured provider, which is why
a build cannot advertise two of them and quietly fail the third.

Presence answers for the deployment, not for every pathname under it. A nested mount, a
filesystem or a kernel that refuses the syscall still fails that one call with
`ENOTSUP`/`EXDEV` — fail closed, with the source and the target entry untouched, and still
no fallback. Untouched means the two entries, not the whole tree: creating the target's
parent chain is part of the supported operation and happens before the refusal, so an empty
parent can outlive it. A case/NFC-only spelling change of the same directory entry uses the direct atomic
rename exception and verifies the source inode afterwards.

`uniquify` is resolved **above** the engines, in the read-model: it picks the first free name
from the snapshot *before* claiming the mutation fence — so the fence guards the path actually
written — and treats the engine's refusal as the arbiter, retrying onto the next name. That is
what makes concurrent duplicates and unindexed files come out right without the engines
learning a third policy. When the create pins an explicit `fileName`, the counter walks the
**basename**; counting the title would re-derive the same pinned path forever.

**What the refusal is not.** It is not a lost save: the draft is untouched and the transport
answers `409` with `reason: note_already_exists` — the same "nothing was overwritten, here is
the other side" shape as the CAS conflict ([contract.md](contract.md#cas)), and the same status
the folder and folder-page name clashes already used. The editor turns it into a choice —
keep editing / save under a free name / open the existing note — because a collision usually
means the user forgot the note exists, and the useful answer is to show it to them.
