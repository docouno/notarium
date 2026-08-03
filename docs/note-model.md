# Notarium Note Domain Model

> Canon of the domain model: note classes, the ontology of names/links, agent-memory, meta-fields, the tags-axis. What the semantic tools of the MCP-gateway (#21) and the surfaces (feed #32, tree #13) hardwire. Code organization (tier/buckets/module form) is a separate canon outside `docs/`. Architectural frame — [manifest P11](architecture.md).

## Note ontology (classes, meta-fields, intent-tool conventions) <a id="note-ontology"></a>

> What the semantic tools of the MCP-gateway (#21) and the surfaces (feed #32, tree #13) hardwire. The class model — [manifest P11](architecture.md) + data-model #74; the tool spec — toolset-v1-spec. A note's identity is `notarium-id` (#51), not its path: move/rename do not change the class and do not break indexes/links. A `[[Title]]` link resolves **id-first → current name (path/file-name/title) → custom slug → alias-history** of past names (#100): a rename (title OR slug) writes the old name into the TARGET's `aliases:` (the bodies of the referencing notes are not touched), so incoming `[[Old Title]]`/`[[old-slug]]` continue to resolve. A note has an editable **slug** (#100 phase 1) — the display/URL axis, decoupled from both the title and the file name (`slug(title).md` on disk is invariant): it is the addressable resolution key (`[[my-slug]]`) and the canonical URL tail `/n/<id>/<slug>` (a stale/incorrect tail resolves by id and is canonicalized on the client). The collision rule is **current > slug > alias**: a custom slug only fills a free key (it does not shadow someone else's live title) but beats a stale alias. Stored LAZILY — `slug:` is written into the frontmatter only when it differs from `slug(title)` (otherwise the default is implicit). Name resolution goes through core `slugify` (the same function across all engines and on the client). **Path-form `[[oldpath/note]]` survives a FOLDER rename (#100 phase 3):** a folder acquires a lazy identity on its first rename, the old path goes into its path-history (server-side marker + meta-DB, drag-and-drop.md §8.6), and the resolver registers an `oldpath/…` key (the lowest pass, after current>slug>alias) — so even an ambiguous file name resolves to the note in the renamed folder rather than to a same-named neighbor. **Cross-space link (#100 phase 5, primitive):** at the resolution level a cross-space and an intra-space link are indistinguishable — a link to a note is its **global note-id** (a PK without the space in the key; `findById`/`/n/<id>`/`/api/previews` are already global), the space is derived rather than part of the key. The human-readable syntax is **`[[space-slug:Title]]`** (a colon, by analogy with GitLab `group/project#123`; NOT `@` — users read that as addressing someone by nick), `space-slug` resolves via space-alias → `space_id` (#100 phase 4). **Rendering** of cross-space links (and materialization of cross-space edges into the meta-graph) is gated behind a hard security precondition of visibility (anti-enumeration #16) → **#66**; phase 5 fixes only the primitive/syntax, no rendering that bypasses authz is built. **Grooming (#100 phase 5):** during graph derivation each edge gets a `resolvedVia` tag (`current`/`slug`/`note-alias`/`folder-alias`); the metric "N links resolve via a former name" = the count of edges with `resolvedVia ∈ {note-alias, folder-alias}` on a **fresh** derivation (NOT a separate persistent reverse-index — it falls out of the already-running derivation). This is visibility only (the `graph/health` dashboard — the metric + a list of broken links); an optional bulk back-fill of bodies is a separate increment, by default the #100 model does NOT touch the bodies of sources.

### Outward terminology
`space` (domain, boundary #16) is an internal term, NOT exposed outward to the agent; the personal domain is implied from the PAT. **`project`** outward = the real addressable unit of work INSIDE a space (a marked folder-entity with the `.notariummeta` marker, #13), NOT a space. The handle = `(space, slug)` (the GitLab `group/project` model: `slug` is unique within a space, same-naming across spaces is disambiguated by the `space` field; the stable `id` is globally unique). The agent addresses a project by handle + relative path, the space is resolved behind the handle; the agent does NOT choose the space/class (poka-yoke). The model canon — [projects.md](projects.md). _(The former "outward-`project` = working space" and the double meaning of the term are canceled by #13: spaces stopped being called "project", real project-entities appeared; a reversal of #74-F3.)_

### Classes and where intent-tools write <a id="note-classes"></a>
| Class | Visibility | Who writes | Convention |
|---|---|---|---|
| `user-doc` | tree/feed/search, freely organized by the user | user (UI) + `create_note` | default `type` + the project folder by handle; escape `path?`/`type?`/`tags?` |
| `agent-memory` | personal domain + a project subdirectory (#13), as a separate section | `remember_about_user` + `remember_about_project` (memory about the user/project) | `category` → category-file; frontmatter `summary` → derived-index |
| `profile` (#159) | HIDDEN from ALL discovery surfaces (tree/graph/feed/search); access only via Settings → Profile + the agent's `start_session` (by id) | `PUT /api/me/profile` (the user writes about themselves) | a singleton in the `.notarium/profile` mount; `type:person`, the `always-load` tag; human content, NOT agent memory (provenance — the user) |

**The write-intent trio (#13)** — the agent does **not choose** the class/folder/space (poka-yoke), the tool imposes it:
- `create_note` → class `user-doc` (knowledge into the project tree by handle `(space, slug)` + `path`);
- `remember_about_user` → class `agent-memory` in the personal domain (memory about the user);
- `remember_about_project` → class `agent-memory` in the agent-mount subdirectory `.notarium/memory/<id>/` (memory about the project; writing is symmetric to `remember_about_user`, reading is space-membership-scoped, not self:read).

_(#13, 2026-06-17: the name `remember_about_project` was RECLAIMED for memory; the former KB-write → `create_note`. The model — [projects.md](projects.md).)_

### agent-memory: structure and behavior <a id="agent-memory"></a>
- **File-per-category, not file-per-observation** (against micro-files): `remember_about_user(observation, category)` appends into the category file; new categories = new files.
- **The index is derived (P11/P13)**: assembled by us from the `summary` frontmatter-field of each memory file; not edited by hand; rebuilt by a full-rescan (#69, P2). eager (the index is loaded into the `start_session` bundle) / lazy (the files themselves are pulled in by `recall`).
- **Visibility** (refines #74, where `agent-memory` had `tree/feed/userSearch=✗`): memory **is visible** in the personal domain, but as a separate section with its own semantics. The user **reads / edits the content / deletes** (audit and control over what an injection could have slipped in — provenance from journal #12), but does **not reorganize** (the section is owned by the agent; a flat set + a derived-index, no user folders). Move is safe (identity on note-id, the index is rebuildable) — so the ban on reorganization is a product decision, not a technical one.
- **A separate mount, dot-namespace** (materialized #78): agent-memory is a typed mount in the same space, physically at `.notarium/memory/` (the system default; a per-space setting may override). The dot-namespace is collision-safe against user folder names (analogous to `.git`/`.obsidian`) and itself falls out of the notes-mount scan (localfs skips dot-directories), so the mounts are non-overlapping without separate logic. It is reserved for all Notarium-managed truth of the space (chat #75 — alongside, `.notarium/chat`); the regenerable derived-index is NOT placed there (app-data, not replicated). The class is **derived from the mount (enforced)** — the agent chooses neither the folder nor the class.
- **One index with a `class` column** (#78, not index-per-class): the engine stamps `class` from the mount onto every row; the visibility checkpoint is single in the read-model (`CachedStore`), not a default `WHERE` in every query. Sliced by `ReadScope`: the default `user` (surfaces hide agent-memory), `agentRecall` (#21) mixes memory in, `all` — sync/inventory. Direct read by id is NOT scoped (the user owns their own memory).
- **Filtering by meta** (`kind`/`class`): feed #32 and the tree can hide/show memory — a special case of the "surface × class" matrix #74 + user control.
- **The `chat` class** (#75) is not included in `recall` v1 (the injection surface of dialogs).

### Note meta-fields
- `notarium-id` — identity (#51), in the frontmatter (P7).
- `kind`/`class` — the note's class (`user-doc` / `agent-memory` / …); the single point of surface filtering (a policy invariant, not a bypassable `WHERE` — #74 §2).
- `summary` — on `agent-memory` files; feeds the derived memory-index. Write semantics (#102): a `summary` passed to `remember_*` **overwrites** the previous one, an omitted one is **carry-forward** (the previous is kept); the response carries `summaryUpdated` (true = overwritten, false = kept) — there is no silent loss.
- `type`, `tags` — the `user-doc` ontology (escape-parameters of `create_note`); `path` is normalized, `..`/absolute paths are rejected.
- always-load — **scoped** `(scope, tag)`, not a flat global tag: user-level is always loaded, project-level — only on a hint (#22, bootstrap §2).

#### Tags as a navigation axis (#109)
A tag is a **navigation axis**, not just a string in the frontmatter. The canonical normalization function is `core/libs/tags` `foldTag` (one across all engines and the client, like `slugify`): **case-insensitive** (`ML`/`ml`/`Ml` — one tag) and **hierarchical** by `/` (segments are trim+lowercase, empties collapse: `Work / Projects` ≡ `work/projects`). Folding happens **only on read/match** — the frontmatter is not rewritten (the original case is stored and shown in the chip; the resolution/grouping key is the folded one). The match is **hierarchical** (`noteHasTag`): a query for the parent `ml` catches descendants `ml/nlp`, `ml/nlp/bert` (a subtree cascade, like folders), but NOT a same-named tag across a segment boundary (`ml` ≠ `mlops`). Where the axis lives: **the read-model snapshot** — the engine returns `tags` on `NoteMeta` (the `notes.tags` column already existed, is FTS-indexed for full-text; for navigation it is NOT an engine table), so the window/histogram/facet/graph are computed over the snapshot under the single visibility checkpoint #78 (agent-memory tags are not exposed on the default surface). The filter (`NotesQuery.tags`) is **OR/union** over the set (the unified model "you added a value → you see more", the same as the folder facet; within a facet it's OR, between facets folder ∧ tag is AND), the contract is an array (a repeatable query-key), the UI multi-selects tags. A future "narrow"/AND mode — a UI toggle over the same array. The `GET /api/s/:space/tags` facet returns a tree of nodes (a flat list of paths+counts, the client nests them like folders) — `count` = subtree population, `direct` = exactly this tag; the shaper is shared — `core/libs/tags` `buildTagFacet` (the same one on the server and in the graph on the client). **The axis UI (feed+graph unified):** the tag-facet = **hierarchical chips + search + top-N** (NOT a tree — on a real base it's too long; NOT a flat cloud — it loses the hierarchy). The interaction model is **inclusion** (as in the whole application): by default nothing is selected, a click on a chip adds a tag (highlighted in accent), a parent chip `▾` expands its children below the cloud, the header × resets; the active filter is read in the aside, **no chips above the content**. On a note's page tags = neutral chips (ready for a per-tag color), clickable → `?tag=`. The canon — recap #109.

## Create collisions: a name is taken <a id="create-collisions"></a>

A note's storage path is derived, not chosen: `slug(title).md` inside its folder, one formula
shared by every engine. So two creates of the same title in one folder aim at the same file —
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
a host-internal capability, so no client can reach it however it composes a request. Its one
caller is the importer, whose idempotency rests on a deterministic `fileName` — a re-import
must land on the same file ([import.md](import.md#idempotency-dedup-on-re-import)).

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
