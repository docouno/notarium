# Notarium Note Domain Model

> Canon of the domain model: note classes, the ontology of names/links, agent-memory, meta-fields, the tags-axis. What the semantic tools of the MCP-gateway (#21) and the surfaces (feed #32, tree #13) hardwire. Code organization (tier/buckets/module form) is a separate canon outside `docs/`. Architectural frame — [manifest P11](architecture.md).

## Note ontology (classes, meta-fields, intent-tool conventions) <a id="note-ontology"></a>

> What the semantic tools of the MCP-gateway (#21) and the surfaces (feed #32, tree #13) hardwire. The class model — [manifest P11](architecture.md#p11) + data-model #74; the tool spec — toolset-v1-spec. A note's identity is `notarium-id` (#51), not its path: move/rename do not change the class and do not break indexes/links. A `[[Title]]` link resolves **id-first → exact raw current path → normalized current name (path/file-name/title) → custom slug → alias-history** of past names (#100): a rename (title OR slug) writes the old name into the TARGET's `aliases:` (the bodies of the referencing notes are not touched), so incoming `[[Old Title]]`/`[[old-slug]]` continue to resolve. That priority has ONE implementation — `core/referenceResolver` ([core.md](core.md#graph-derivation)) — which graph derivation, the read-model and both engines consume; a client does NOT re-derive it, because its session inventory is partial: `resolveKnownWiki` completes only a stable id it can already prove, and every human name/path/slug/alias goes to `api.noteResolve` → the server's `KnowledgeStore.resolveWikilink`. Exact raw path precedes normalization so legal case/NFC-distinct files resolve the same way in graph derivation and direct reads; a non-exact spelling uses the deterministic normalized collision winner. A note has an editable **slug** (#100 phase 1) — the display/URL axis, decoupled from both the title and the file name (new notes default to `slug(title).md`; an imported, explicit or safely recovered basename stays put until an explicit naming/move intent): it is the addressable resolution key (`[[my-slug]]`) and the canonical URL tail `/n/<id>/<slug>` (a stale/incorrect tail resolves by id and is canonicalized on the client). The collision rule is **current > slug > alias**: a custom slug only fills a free key (it does not shadow someone else's live title) but beats a stale alias. Stored LAZILY — `slug:` is written into the frontmatter only when it differs from `slug(title)` (otherwise the default is implicit). Human-name keying uses core `nameKey`/`namePathKey` in the shared resolver and its engine/read-model consumers; the client only shares wikilink-target normalization before its stable-id fast path — see [Names in any script](#name-alphabet). **Path-form `[[oldpath/note]]` survives a FOLDER rename (#100 phase 3):** a folder acquires a lazy identity on its first rename, the old path goes into its path-history (server-side marker + meta-DB, drag-and-drop.md §8.6), and the resolver registers an `oldpath/…` key (the lowest pass, after current>slug>alias) — so even an ambiguous file name resolves to the note in the renamed folder rather than to a same-named neighbor. If two folder identities claim the same retired name, the history axis is ambiguous and resolves nothing instead of selecting by list order; stale folder URL redirects use the same fail-closed rule. **Cross-space link (#100 phase 5, primitive):** at the resolution level a cross-space and an intra-space link are indistinguishable — a link to a note is its **global note-id** (a PK without the space in the key; `findById`/`/n/<id>`/`/api/previews` are already global), the space is derived rather than part of the key. The human-readable syntax is **`[[space-slug:Title]]`** (a colon, by analogy with GitLab `group/project#123`; NOT `@` — users read that as addressing someone by nick), `space-slug` resolves via space-alias → `space_id` (#100 phase 4). **Rendering** of cross-space links (and materialization of cross-space edges into the meta-graph) is gated behind a hard security precondition of visibility (anti-enumeration #16) → **#66**; phase 5 fixes only the primitive/syntax, no rendering that bypasses authz is built. **Grooming (#100 phase 5):** during graph derivation each edge gets a `resolvedVia` tag (`current`/`slug`/`note-alias`/`folder-alias`); the metric "N links resolve via a former name" = the count of edges with `resolvedVia ∈ {note-alias, folder-alias}` on a **fresh** derivation (NOT a separate persistent reverse-index — it falls out of the already-running derivation). This is visibility only (the `graph/health` dashboard — the metric + a list of broken links); an optional bulk back-fill of bodies is a separate increment, by default the #100 model does NOT touch the bodies of sources.

An unambiguous plain ID remains a valid authored target. Intent tools use the total
reserved form **`[[notarium-id:<percent-encoded-id>|Readable title]]`**, so an opaque
ID containing `#`, `|`, `]` or ending in `.md` cannot be mistaken for a human name,
fragment, alias separator or storage filename. A miss in that namespace is a
non-creatable tombstone: minting a different note cannot restore the missing identity.
When a resolved target disappears, the read-model re-derives every cached inbound source
from its body against the post-delete index. A resolved edge is deliberately deduplicated
and cannot remember whether the author wrote a human target, a stable envelope, or both;
guessing from that projection would turn a creatable forward reference into a tombstone.

### Outward terminology
`space` (domain, boundary #16) is an internal addressing term, NOT exposed outward to the agent; the personal domain is implied from the PAT. The one descriptive exception is an effective role summary with `scope: 'space'`: it reports why that owned role won, but carries no space selector and cannot choose placement or access. **`project`** outward = the real addressable unit of work INSIDE a space (a marked folder-entity with the `.notariummeta` marker, #13), NOT a space. The handle = `(space, slug)` (the GitLab `group/project` model: `slug` is unique within a space, same-naming across spaces is disambiguated by the `space` field; the stable `id` is globally unique). The agent addresses a project by handle + relative path, the space is resolved behind the handle; the agent does NOT choose the space/class (poka-yoke). The model canon — [projects.md](projects.md). _(The former "outward-`project` = working space" and the double meaning of the term are canceled by #13: spaces stopped being called "project", real project-entities appeared; a reversal of #74-F3.)_

### Classes and where intent-tools write <a id="note-classes"></a>
| Class | Visibility | Who writes | Convention |
|---|---|---|---|
| `user-doc` | tree/feed/search, freely organized by the user | user (UI) + `create_note` | default `type` + the project folder by handle; escape `path?`/`type?`/`tags?` |
| `agent-memory` | personal domain + a project subdirectory (#13), as a separate section | `remember_about_user` + `remember_about_project` (memory about the user/project) | `category` → category-file; frontmatter `summary` → derived-index |
| `profile` (#159) | HIDDEN from ALL discovery surfaces (tree/graph/feed/search); access only via Settings → Profile + the agent's `start_session` (by id) | `PUT /api/me/profile` (the user writes about themselves) | a singleton in the `.notarium/profile` mount; `type:person`, the `always-load` tag; human content, NOT agent memory (provenance — the user) |
| `skill` (#307) | hidden from generic tree/graph/feed/search/recall; visible through Agents → Roles and role resolution only | the human `Add` flow (editing follows in #309) | valid Agent Skills packages in `.notarium/skills`; Personal/Space at the mount root, Project under reserved `_projects/<encoded-project-id>/`; Markdown members participate in current note versioning/replication, while auxiliary bytes are retained verbatim and included in `scope=all` export/data backup but remain outside the note journal |

**The write-intent trio (#13)** — the agent does **not choose** the class/folder/space (poka-yoke), the tool imposes it:
- `create_note` → class `user-doc` (knowledge into the project tree by handle `(space, slug)` + `path`);
- `remember_about_user` → class `agent-memory` in the personal domain (memory about the user);
- `remember_about_project` → class `agent-memory` in the agent-mount subdirectory `.notarium/memory/<id>/` (memory about the project; writing is symmetric to `remember_about_user`, reading is space-membership-scoped, not self:read).

_(#13, 2026-06-17: the name `remember_about_project` was RECLAIMED for memory; the former KB-write → `create_note`. The model — [projects.md](projects.md).)_

### Roles and skills <a id="roles-and-skills"></a>

A skill is a portable, bounded Agent Skills package: `<name>/SKILL.md` plus optional
`scripts/`, `references/`, and `assets/`. Add copies every member: auxiliary files remain
byte-identical, while `SKILL.md` is rewritten with immutable built-in provenance. The server never
executes scripts, and role activation progressively loads only the Markdown instructions. A role is the
same valid package with
`metadata.notarium.kind: role`; `metadata.notarium.skills` links its supporting packages by wiki
name. The packaged catalog is a separate read-only source. It is not a scope and is never loaded by
an agent until a human explicitly copies a template into an owned library. Copying records origin
and catalog revision, but produces an independent fork: no catalog update overwrites it.
Agents → Roles exposes a read-only detail for both sources: the complete role instructions and
the supporting skills loaded with it. The list description remains discovery metadata; it is not
a substitute for the package body. Editing an owned fork is a separate capability (#309).

Owned resolution is by package name: `Project > Space > Personal`. Personal means private to the
user across projects; Space means shared inside one space; Project is the narrowest. There is no
mutable global scope and no stored enable flag: presence in an owned scope means effective, while
the one role selected in a durable agent episode is separately called active. No selection means
base mode, not a synthetic base role.
An active named episode fork inherits its parent's selected role; a brand-new episode starts in
base mode. Resolution is repeated on hydration, so the inherited name may pick a newer narrower
owned fork in the new project context.

Each owned role placement may also carry a context preset: ordered pins and context sets stored in
the meta-DB against `(placement scope, stable owner id, role name)`. The preset belongs to the owned
copy; a catalog template has none and is never effective before Add. Same-name Personal, Space, and
Project copies therefore keep independent presets, and the exact placement selected for the role
body selects the preset too. At session load it is the most-specific layer under the existing
Personal/Project budget (`Role → Project → Personal`), not a separate allowance. It adds no grants
and no role-scoped memory, delta, or index. Without a meta-DB the file-first role package and its
instructions still work; only the preset and durable session selection degrade away (P5).

### agent-memory: structure and behavior <a id="agent-memory"></a>
- **File-per-category, not file-per-observation** (against micro-files): `remember_about_user(observation, category)` appends into the category file; new categories = new files.
- **The index is derived (P11/P13)**: assembled by us from the `summary` frontmatter-field of each memory file; not edited by hand; rebuilt by a full-rescan (#69, P2). eager (the index is loaded into the `start_session` bundle) / lazy (the files themselves are pulled in by `recall`).
- **Visibility** (refines #74, where `agent-memory` had `tree/feed/userSearch=✗`): memory **is visible** in the personal domain, but as a separate section with its own semantics. The user **reads / edits the content / deletes** (audit and control over what an injection could have slipped in — provenance from journal #12), but does **not reorganize** (the section is owned by the agent; a flat set + a derived-index, no user folders). Move is safe (identity on note-id, the index is rebuildable) — so the ban on reorganization is a product decision, not a technical one.
- **A separate mount, dot-namespace** (materialized #78): agent-memory is a typed mount in the same space, physically at `.notarium/memory/` (the system default; a per-space setting may override). The dot-namespace is collision-safe against user folder names (analogous to `.git`/`.obsidian`) and itself falls out of the notes-mount scan (localfs skips dot-directories), so the mounts are non-overlapping without separate logic. It is reserved for all Notarium-managed truth of the space (chat #75 — alongside, `.notarium/chat`); the regenerable derived-index is NOT placed there (app-data, not replicated). The class is **derived from the mount (enforced)** — the agent chooses neither the folder nor the class.
- **One index with a `class` column** (#78, not index-per-class): the engine stamps `class` from the mount onto every row; the visibility checkpoint is single in the read-model (`CachedStore`), not a default `WHERE` in every query. Sliced by `ReadScope`: the default `user` (surfaces hide agent-memory), `agentRecall` (#21) mixes memory in, `all` — sync/inventory. A semantic operation that already addresses one class may additionally pass `classes` as candidate narrowing: the engine pushes it into `idx_notes_class`, then `CachedStore` still intersects the result with `ReadScope` (optimization, never a visibility bypass). Thus the derived memory index enumerates and reads only `agent-memory` rows; its cost follows the memory mount, not the ordinary-note corpus. A read of a graph-invisible class also never derives or patches user-graph edges: wikilinks inside memory remain inert instead of rebuilding the visible corpus's link index. Direct read by id is NOT scoped (the user owns their own memory).
- **Filtering by meta** (`kind`/`class`): feed #32 and the tree can hide/show memory — a special case of the "surface × class" matrix #74 + user control.
- **The `chat` class** (#75) is not included in `recall` v1 (the injection surface of dialogs).
- **Concurrent appends into one category converge** (#341): an append is serialized on the category's durable identity — its name key (`nameKey`, the axis the lookup MATCHES on, not the one the file is named on) plus its partition (the about-user root vs `<project-id>/`) — across the whole find-or-create-append window, not merely the store write inside it. Different categories and different partitions stay parallel. The task's self-token writers inside that fence are `remember_about_user` / `remember_about_project` and the mute toggle; a remember call carrying a caller token still takes the fence so its fail-fast check and write are atomic. Outside it, answering an honest conflict: `edit_note` **with** a caller token and the REST update — fail-fast by contract, the token's owner is the client; and, as a **known boundary rather than a guarantee**, `edit_note` **without** a token, `link`/`link_many` and `rename_note`, which also write under a self-read token but are not fenced. Against writers outside, a lost CAS is retried only while somebody is actually committing (a bounded budget); exhausting it answers `memory_convergence_exhausted` — a distinct reason, because the caller never held a token and so cannot act on "re-read and retry". A file edited behind our back is a third failure, not a conflict: it surfaces as `# Write Failed` (index desync), is cured by reconciliation and is deliberately not retried. The guarantee is per-process, like every fence here ([core.md](core.md)).

### Note meta-fields
- `notarium-id` — identity (#51), in the frontmatter (P7).
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
fallback is possible. Runtimes without the syscall — another platform, an unmapped
architecture, a filesystem or kernel that refuses it, or an interpreter that cannot be
executed — fail with `ENOTSUP` rather than use a check-then-rename approximation. The role
library publishes an owned package with the same primitive. A case/NFC-only spelling change of the same directory entry
uses the direct atomic rename exception and verifies the source inode afterwards.

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
