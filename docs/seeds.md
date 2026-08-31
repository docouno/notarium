# Seed catalog for stands (#175)

Populating stands and fixtures for cases by hand is painful: to see a feed «with
scroll vs without», an empty/full trash, a rich reader (tables/code/callouts/mermaid/katex),
a folder-page, the graph, a multi-space with memory — you previously had to either
click the data into an empty engine or hardcode a fixture in every spec. The catalog
provides **a single declarative source of cases**, applied to **two stands**:

- **fake backend** (e2e/visual) — `caseToFixture(world)` → the fake's regular `Fixture` +
  `POST /api/__test/reset`;
- **real engine** (manual QA) — in-process `scripts/seed.ts` (`make seed`).

The goal is not to «pour in content for show», but **a broad base of all our cases +
edge cases**, with honesty (content is verified against the real render) and
extensibility (adding a case/fragment/axis = adding a single object).

## Crux: why seeding must be in-process

All activity (heatmap, the «What changed» feed, active-projects, trash, history,
delta-since) is derived from the **revision journal (#12)**. The journal stamps every
row with `createdAt = now()`, and **no HTTP/MCP/import path sets the journal date**
(`revisionJournal.ts`). Hence two «dishonest» outcomes that the seeder avoids:

- **drop `.md` + reindex** → notes are not journaled (or it is an `external` baseline,
  which the heatmap SQL excludes) → list/search exist, **the heatmap is empty**;
- **REST/MCP/import** → the journal is written, but everything collapses into **a single
  spike «today»**.

Honest backdating is achievable only **in-process**: the seeder builds the production
`CachedStore` with a **clock injection** (`now: () => clock`) and replays the timeline
through the real `store.write` / `remove` / `restoreFromTrash`. The file, read-model,
search index, identity registry, and project markers self-populate (P2), while the
journal row receives the chosen instant with a correct `base_rev` / `charsAdded` /
`class` chain. The journal's `noteId` = the real `notarium-id`, `space` = the opaque
space-id — the consistency invariants from the task statement fall out «for free».

## Architecture — 4 layers

1. **Content corpus** (`test/cases/corpus/`) — an addressable, dependency-light library
   of markdown **fragments**: each = one render edge case, with a ref to its source
   (issue / render test / fixture). **Honesty is enforced by a test**: every fragment is
   run through the REAL `renderMarkdown` (`test/cases/corpus.honesty.test.ts`) — a
   fragment cannot claim a render that the reader does not produce.
2. **Cases** (`test/cases/cases/`) — they **compose** fragments + structure + activity
   (they do not inline content). Reader cases are built FROM the corpus and auto-grow
   together with it.
3. **Axes + coverage matrix** (`axes.ts`, `coverage.ts`) — 22 product axes, each tied to
   surfaces + a canon doc; cases tag `axes`. `make seed-coverage` prints the matrix; the
   coverage test fails on a gap.
4. **Appliers** — `caseToFixture` (fake) and `scripts/seed.ts` (real). The case model is
   a neutral **timeline** of events, from which BOTH projections are derived. An `edit` may carry a
   production-canonical destination `path`; both appliers preserve the identity minted by `create`,
   move the note through their normal write seam, and keep the actual returned path for subsequent
   delete/restore events.

## Content corpus (`corpus/*`)

One file per feature (`headings`, `code`, `tables`, `callouts`, `footnotes`, `wikilinks`,
`math`, `mermaid`, `unicode`, `security`, `pathological`, `imports`, …). A fragment:

```ts
{ id, feature, exercises, md, refs?, expect? } // expect: { contains?, excludes?, security? }
```

Grounded on `markdown.test.ts` (#235/#236/#237), the e2e inline fixtures, and `base.json`.
It also covers what had no fixture at all in the repo: Cyrillic/Greek/Vietnamese/CJK/**RTL**,
emoji, nested quotes, `~~~`/no-language code, escaped-md, only-frontmatter, duplicate-h1,
broken mermaid/katex, XSS payloads, inert `\href`, etc. Helpers: `fragmentsByFeature`,
`pickFragments`, `composeNote`.

**Honesty test** (`corpus.honesty.test.ts`, carrying a `jsdom` docblock because DOMPurify
needs one — the only such file under `test/`, though `packages/web` has its own in the same
run): for each fragment — «does not throw + non-empty», `contains`/`excludes`,
and for `security` — it parses the sanitized HTML into a live DOM and checks that no
`<script>` / `on*=` handler / `javascript:` URL survived. The rest of `test/` stays node-only.

## Cases

**Structure / spaces / folders / classes:**

| Case | About | Axes |
|---|---|---|
| `multi-space` | 3 spaces + a personal domain with memory + **live/archived/shadowed/ambiguous space aliases** + **archived scratch** + a **zero-grant recovery user** + **connected apps with narrowing** + **pending OAuth registration** | structure, agent-memory, auth, note-classes, trash, identity |
| `folder-page` | `index.md` pages (nested), children summary, breadcrumbs (#212-214) | folder-page, structure, content |
| `note-classes` | one note per class — visibility matrix for user-doc/agent-memory/profile (#78/#74) | note-classes, agent-memory, structure |
| `explorer-scroll` | a deep tree: a note near the bottom + many collapsible folders above — the explorer scroll-position invariant (#242): a reflow above the open note does not move the scroll | structure, scale |
| `tree-sort` | three Files notes + three personal-memory categories whose Name, Created and Modified orders all differ (#314); login `sam` / `seed-pass` | structure, agent-memory, activity |
| `scrollbars` | overflows ALL scroll surfaces at once (#176): the tree rail, a long note in reader/editor, the feed, a dense graph + asides, a full trash — a showcase of auto-hide + glass-inset | scale, structure, content, graph, activity, trash |
| `favorites` | the merged Files+Feed section (#245) + the Favorites lens (#42): feed + tree, favorite notes in different folders + a favorite folder + a favorite project | favorites, structure, activity |

**Activity / history / trash:**

| Case | About | Axes |
|---|---|---|
| `feed-scroll` | ≈300 notes over a year, backdated + partially edited (#68) | activity, scale |
| `dashboard-activity` | a multi-week history, 2 authors, projects, broken links (#216/#218) | activity, history, graph |
| `trash-empty` | trash zero-state (#79) | trash |
| `trash-mixed` | deleted notes + folder + project + a **deleted-then-restored** note (#79/#184) | trash, history |
| `trash-long` | a large composite trash: a long list of deleted notes (scale) beyond the viewport — scroll-glass chrome (#185/#247) + deleted spaces (the Notes/Spaces toggle), a deleted folder, a note from a project, restored | trash, history, scale |
| `trash-recovery` | realistic recovery queue: many exact copies, one older partial copy, source-only and record-only rows, an archived space, a live path collision; `SCALE=5` crosses Select-all-N pagination | trash, history, scale |
| `history-rich` | a deep revision chain, 2 authors, rename, raw plugin frontmatter and a metadata-only revision visible in Changes (#203/#160) | history, identity |
| `restore-states` | exact CRLF/comments/Unicode + receipt-owned fields in live history and a safe deleted state, blocked YAML-owner coupling, legacy partial, honest gap, opaque UTF-8/binary and valid/invalid direct `SKILL.md` states (#275); a live 830 KB note (constant — `SCALE` does not multiply it) and a live control-byte note planted via the external-rewrite seam, whose MCP write answers with the addressed refusal (#392) | history, trash, note-classes |

**Graph / identity / search:**

| Case | About | Axes |
|---|---|---|
| `wiki-web` | a dense wikilink graph, alias/ghost (#202/#100), and a physical-id target titled `[MCP] Review` with a bracket-safe identity alias | graph, identity, content |
| `graph` | hubs/orphans/ghost-by-refcount/former-name/cross-folder communities (#38/#202) | graph, identity |
| `graph-load` | scalable linked communities: 300 nodes / ~900 links per scale unit; `SCALE=10` reproduces the 3k/9k cold-enrichment workload (#195/#284) | graph, scale |
| `search-corpus` | a spotlight corpus: same-named notes, content/path-match, tag case-fold (#188/#204) | search, content |
| `external-edits` | writers that are not us: a same-size, mtime-preserving rewrite whose search marker + graph edge must self-heal on boot/poll (#267), plus exact whole-file shapes — a byte-order-marked file, stable rule-led prose and a full CRLF storage form for byte-preserving saves | search, graph, content |
| `identity-collision` | one `notarium-id` planted in two spaces on disk: the arbiter must leave a single durable owner and re-mint the loser on the next boot (#327) | identity, structure, history |
| `legacy-slug-links` | notes moved from old ASCII-only filenames onto Unicode paths: one unique legacy link survives delete/restore, while a two-owner old basename remains a ghost | identity, graph, search, history, trash, structure |
| `name-collisions` | the states that flow from "a title picks the file name": a folder primed for the refusal dialog, an already-uniquified `Retro`/`Retro 2`/`Retro 3` family, the same title in two folders, and a folder page whose reserved `index.md` deliberately does not collide — [note-model.md](note-model.md#create-collisions) | identity, structure |

**Declared meta fields (the field axis):**

| Case | About | Axes |
|---|---|---|
| `fields` | a shared writer/reader field lab plus the authored-frontmatter corpus and real schema: all six types, stable enum labels/colors, semantic palette, five uncapped `card:true`, exact list scalar ` Doe, Jane `, day/moment, empty/mismatch/protected/open-world and every indexed cap state, including primary Type outside the blob. Three sibling spaces carry exact future/form/structural `schema.yaml` states. Both fake and real appliers materialize valid and raw schema resources without hand preparation | fields, auth |
| `fields-scale` | 10000 notes with twelve author keys each (ten scalars and two lists) — the corpus the snapshot's field projection is measured on by `make bench-fields-snapshot`, and the one the ladder's re-derivation is priced on by `FIELDS_BACKFILL_CASE=fields-scale npx vitest run test/integration/fieldsBackfill.test.ts` (that gate namespaces its knobs on purpose — a bare `CASE` exported for the seed CLI must not steer a test `npm test` sweeps up) | fields, scale |

**View documents and boards:**

| Case | About | Axes |
|---|---|---|
| `views` | writer/reader board project: declared zero-count colored columns, observed/absent/empty/unreadable/rankless cards, an enum `card:true` color chip omitted from authored view fields, two boards with independent ranks, unknown secondary reader, duplicate/count/byte/resource and unsafe-YAML carrier states, missing/mismatch/stale markers, exact CRLF/comment witness, prose-only and config-only search tokens | views, fields, auth, search |
| `views-scale` | 10000 task notes, 10 columns, 50 view documents over one snapshot, a 9900-line JSONL rank scalar and deterministic rankless tail; `SCALE` scales only task population | views, scale |

**The last three states of `fields` are sized FROM `FIELDS_BLOB_BYTE_CAP`, never against it.**
The cap-overflow notes carry twice the cap's worth of key names, computed in the case rather
than typed in, so retuning the cap retunes the corpus with it. Written the other way round —
literal counts tuned to a 1.2× margin — a cap raised from 4096 to 6144 switched all three
states off without a single red test, and every derived number here and in the case's comments
went on describing a split that no longer happened. `test/cases/fields.test.ts` is the gate:
it demands the states, and it demands the margin they are sized to.

**Its POPULATIONS are held the same way — as shapes, not as counts.** The three the brief's
criterion 7 reads off this case (a board of three notes and three values — a corpus too small
for a threshold to judge, the same shape at 40 notes where the key identifies rather than
groups, and a list key whose distinct values outnumber its notes without any of them alone) are
what the facet's selection rule has to tell apart, and the numbers they come to are consequences
rather than decisions: how many distinct reviewers 20 notes show is what `i % REVIEWERS.length`
produces, not something anyone chose. So the row above states the relations, the case declares
the vocabularies, and the gate derives every count from the seeded notes — including the one
comparison that is a count at all, `distinct reviewers == REVIEWERS.length`, which holds two
derived things against each other. The same gate demands that some notes carry NO author keys:
without them `FIELDS_BACKFILL_CASE=fields` reports `rowsRederived == filesRead` and the pair of
counters stops distinguishing a re-derived row from an adopted one.

**Content / reader:**

| Case | About | Axes |
|---|---|---|
| `reader-showcase` | a note for EVERY markdown feature, assembled from the corpus | content, note-classes |
| `long-document` | the entire corpus as one long note — reading-size/outline/scroll/diff (#27/#189) | content, scale, history |

**Public demo (#256)** — the one case whose output is a published artifact:

| Case | About | Axes |
|---|---|---|
| `demo` | a self-hosting developer's knowledge base (architecture / decisions / runbooks / an incident) — the source for the landing-page, README and docs-site screenshots. Strings live per-locale in `test/cases/demo/`; the case owns only the shape. Carries ONE agent-signed revision on purpose (the history frame). Shot with `make demo-shots` — see [demo-screenshots.md](demo-screenshots.md) | content, structure, history, activity, graph, search, auth |

**Model providers:**

| Case | About | Axes |
|---|---|---|
| `providers` | encrypted credential/resource carriers in both appliers; two resources sharing one credential, an unreferenced credential, resource without credential, disabled/mismatched/unreadable/deactivated-owner states, active/pending/awaiting-reconsent attachments, a near-expiry offer and an archived target whose attachment remains intact | providers, auth |
| `providers-disabled` | the subsystem capability is off over a non-empty encrypted provider database: routes/tabs stay absent while credential/resource rows and backup input survive | providers, auth |

`make provider-scale-gate` is the disposable volume counterpart to these manual cases. It
loads 10,000 credentials, resources, attachments and terminal call rows through the real
SQLite provider contour, then prints numeric startup, effective-resolution, consent,
retarget, key-rotation and retention results. Correctness and constant persistence-port
counts are asserted; machine-dependent milliseconds and heap are recorded, not frozen as
thresholds.

**Agent memory / import:**

| Case | About | Axes |
|---|---|---|
| `agent-context` | pins + personal/project memory + projects of varying density (#165), including the pinned `product/index.md` **Folder overview #311**; **heavy pins over budget + a `Budget Lab` space for all token-budget cases #208** (fits / squeeze / no-pins / set-trim — nesting the personal set into project Q's budget; `squeeze` lands the cut on a heavy pin and `set-trim` lands it INSIDE the cross-space set, the one state where a trimmed set item and a trimmed pin are under one caption); **cross-space context set #209** (`Frontend Canon` in the `Conventions` space, connected to project Product OS + personal) **+ cross-space loose pin #209** (`Security Baseline` from `Conventions`, pinned directly into Product OS + personal) — both resolve cross-space; **retrieval audit #243** (search/recall/get_note history: hits + a recurrent vocabulary-mismatch miss + frequent queries) | agent-memory, agent-audit, structure, note-classes, scale |
| `agent-sessions` | Activity: active fork siblings, a sticky project hint, exact call vs audited read/write counts, declared/inferred attachment, `Outside sessions`, an archived snapshot whose lifecycle row was GC'd, a mixed history longer than one 50-row page, an equal-timestamp read/write cursor boundary, hostile and max-length unbroken labels, owner isolation, distinct root/fork/owner delta positions, and an owner whose Agent facet runs five labels long — past the compact ceiling that facet used to carry, kept as a real-stand state (see below) | agent-sessions, agent-audit, auth, history |
| `agent-telemetry-detailed` | Full session review corpus with Detailed enabled: Compact-vs-Detailed calls, every real producer outcome/effect/domain, recurring validation failures, linked retrievals and multi-revision mutations, Outside, complete/partial/archived and cross-owner episodes, plus durable retention→human pending and human-cleanup-complete marker states | agent-sessions, agent-audit, auth, history |
| `agent-roles` | five principals keep the boundary visible: Fresh is catalog-only; Bob owns an idle Personal fork; the default stand owner Sergey owns a Personal `release-reviewer` with distinct Base/Role pins plus editable Personal and Main-project Memory rows; Maya owns switchable Personal `research`/`grooming` presets plus same-name Research Space + two Project role forks. Its skill library has Personal and Space homes, `coder` bound to Team Alpha/Beta but not Gamma, an all-projects skill, a direct catalog fork with provenance, an exact-linked rename, a custom exact link, duplicate names, and a deleted package retained as a broken role reference. A long Custom role preserves authored body and carries one legacy malformed attachment for preserve-vs-detach editing; another owned role remains in Personal Trash. Robin can inspect the Team home read-only. Base Personal/Project pins remain visible, each role placement has a distinct pin, the Team Project role adds a set plus an oversized tail that trims under the shared `Role → Project → Personal` budget, and an active episode rehydrates `research` | agent-roles, agent-sessions, agent-memory, auth, structure, scale |
| `agent-abilities-rich` | the same axis at VOLUME on the default login, where `agent-roles` proves boundaries with one placement each: Personal, Space and three Project role groups populated at once, BOTH inventories past the library/explorer page sizes, a title long enough to force truncation everywhere it is listed, one display name deliberately held at two placements, a `launch-review` Space role narrowed to two of the Space's projects with its own version in one of them, a version whose base was never created, and a Space skill fleet whose availability differs per project (all / one / several). It seeds project and personal Catalog dependencies at their real homes, exact-linked rename, malformed and deleted attachment health, plus the RC package-delete boundaries: both Markdown and non-Markdown auxiliaries make agent `delete_ability` refuse and preserve the package, while the unchanged human multi-file door can remove the Markdown package into Trash. `agent-created-oversized-proof` is published through the durable agent creator with PAT/session provenance, exceeds 64k characters, and is pinned by its real note id into Web; it simultaneously proves Activity attribution, fail-closed `use_skill` and generic MCP context filtering. Most of its projects hold no ability at all, and that is deliberate: the library aside's Project facet has no pagination and no scroller of its own, so the LENGTH of that facet is the state — long enough that the aside's own scroller is the one that moves. Counts are derived from `buildCasesWorld`, never pinned in prose. | agent-roles, agent-memory, agent-audit, structure, auth, scale |
| `agent-abilities-sparse` | the other end of the same axis: a first-run stand with System and Catalog plus exactly one Owned skill and no Owned role at all — the empty groups, the single-row group and the skeleton geometry that a fully populated stand can never show | agent-roles, structure, auth |
| `context-open` | production-shaped #394/#399 performance stand: 1100-note project + 2700-note personal corpus, one editable Custom Project Role in `context-lab/product`, linked graph/activity, 90 × ~6.5 KB project-memory categories (`SCALE=.045` → 4; `1` → 90; `3` → 270), 8 personal categories, 12 × ~13.7 KB always-load pins and a profile note; SCALE changes only the project-memory count | agent-memory, agent-roles, activity, graph, note-classes, scale, structure |
| `context-sets-cost` | dedicated #406 performance/manual stand: 1100-note project corpus, six large pins, a 1000-member attached set, an isolated 5-member dedup set, a full role-identity set and an empty bulk target; it owns the membership-bound benchmark data root and never changes frozen `context-open` | agent-memory, agent-roles, auth, scale, structure |
| `graph-revision` | production-shaped #410 benchmark fixture: one mutation source selected by `revision-query-marker` and one adjacency target; `make graph-revision-gate` adds the deterministic 1355-note filler corpus to reach 1357 notes / ≥20.3 MiB / 2013 wikilinks without making every catalog projection carry benchmark bytes | graph, search, scale, structure |
| `memory-perf` | 2700 ordinary notes + 4 personal-memory categories + 1 project-partition sentinel; reproduces memory-mount scaling, partition isolation, and graph-inert memory links | agent-memory, note-classes, scale |
| `import-thread` | one rich imported thread | import, content |
| `import` | a multi-format layout (claude/chatgpt/memory-json) + backdated dates-as-data → Feed year-spread (#11/#223); source-addressable Claude/ChatGPT notes carry canonical `notarium-source`, including two same-titled CJK project docs with distinct portable placement, beside one deliberately source-less legacy predecessor; plus `dropped/` — the states of a dragged-in `.md` archive whose OWN frontmatter was lifted (#280): authored tags + date, an Obsidian note titled by its file name with `aliases:` and plugin keys kept, a Jekyll post whose `title:` beats a differing body `# H1`, and a frontmatter-less note dated by the file's mtime; plus `vault/` — a Markdown TREE imported from a `.zip` (#302), its nested folders reproduced and its internal exact `[[notarium-id:…]]` links repointed at the COPIES (with a fenced-code copy left as authored) | import, content, activity |

### A fixture-pinned physical id (#302)

Normally each applier derives a note's physical identity for itself — the fake deterministically from the path, the real stand from the store — and a case addresses notes only by the logical `n-*` handle. A case must pin the physical id (`note({ id })`) when a note's CONTENT names an identity: an authored `[[notarium-id:…]]` resolves only if the target really carries that id. The pin then has to reach EVERY projection that exposes an identity — the snapshot, the activity/history rows, and a declared `revisionState`, which stamps the id into the seeded bytes (`{{noteId}}`) as well as onto the row — or one surface would describe a different note than the other, and every surface addressed BY that id (navigation, the history panel, a resolved wikilink) would follow whichever one it happened to read. One rule decides it — `physicalIdOf` = `state.id ?? deterministicNoteId(path)` — and no projection re-derives beside it: the activity and revision projections call it, and the snapshot hands the pin to the in-memory store, which applies the same fallback. The real applier forwards the pin to `store.write({ id })`. The `import` case uses it for the imported vault's two linked notes.

**Both halves are pinned, and the real one had to be pinned differently.** The fake side is a fake-server case (`test/fake-server/seedCatalog.test.ts`) that reads the pinned id back off the snapshot, the graph edge and the history rows. The real side could not be: `scripts/**` is outside the test runner's `include`, so nothing there is executed by the suite and the one line that forwards the pin could be deleted with everything still green. `test/cases/seedRealProjection.test.ts` therefore runs the applier as what it is — a CLI, against a throwaway data root — and asserts the frontmatter of the files it wrote, which is the projection a stand actually serves and the string an authored `[[notarium-id:…]]` in a sibling note has to match.

## Axes and coverage

22 axes (`axes.ts`): `content`, `structure`, `folder-page`, `activity`, `history`,
`trash`, `identity`, `search`, `graph`, `agent-memory`, `agent-audit`,
`agent-sessions`, `agent-roles`, `note-classes`, `import`, `jobs`, `scale`, `auth`,
`fields`, `views`, `favorites`, `providers`. Each is tied to surfaces + canon docs.

```
make seed-coverage      # axis×case + feature×fragment matrix + gaps
```

The coverage test (`coverage.test.ts`) is a guard: it fails if an axis has no case, a
case has no axis, or a feature has no fragment. This way an «uncovered surface» is
caught rather than silently skipped.

## CLI

```
make seed-list                                     # list of cases
make seed CASE=reader-showcase                      # (re)seed the local stand
make seed CASE=providers                            # provider management/consent states
make seed CASE=providers-disabled                   # populated DB, served capability off
make provider-scale-gate                            # 10k provider startup/read/maintenance artifact
make bench-session-audit BENCH_PHASE=pre            # current-main Activity baseline
make bench-session-audit BENCH_PHASE=post           # trace pages/writes/storage/export/full cleanup
make seed CASE=tree-sort                            # explorer Name/Created/Modified QA
make seed CASE=views                               # board/discovery/failure QA
make seed CASE=views-scale SCALE=.01               # reduced summary/rank scale stand
make seed CASE=dashboard-activity SCALE=1 SEED=x PASSWORD=secret
make seed CASE=reader-showcase,graph,trash-mixed    # COMBINATION of cases
make graph-revision-gate                           # disposable #410 runtime + memory gate
make seed CASE=context-sets-cost                   # #406 heavy/small/role context-set states
make graph-revision-gate GRAPH_REVISION_COMMIT=<frozen-tree> # explicit dirty-tree proof
make seed-coverage                                  # coverage matrix
```

`bench-session-audit` refuses tracked or untracked working-tree changes so its commit/tree
identity describes the exact copied source. The post report exercises production Activity reads,
Compact and Detailed writes, paged export and complete bounded-cleanup convergence on both drivers.
Its storage samples are logical row payload, not database-file or index allocation: SQLite records
the encoded persisted columns and linked sidecars (`sqlite-json-payload-v1`), while PostgreSQL uses
`pg_column_size` over the same owned rows (`postgres-row-size-v1`). The method is carried per sample
so values are compared across modes and dataset sizes within a driver, never presented as identical
physical-byte accounting across engines.
Cleanup convergence reports every yielded pass and gates both its p99 transaction time
(250 ms SQLite / 1 s PostgreSQL) and a separate hang ceiling (500 ms / 5 s); history-scale ratios
use the same 5 ms material floor as baseline comparisons so sub-millisecond planner noise cannot
masquerade as dataset-proportional work.
The aggregate bundle is limited to the stricter of its driver ceiling (3.5 s SQLite / 300 ms
PostgreSQL) and baseline plus the greater of 20% or 150 ms; the fixed allowance accounts for the
new agent/problem summaries without permitting the earlier multi-second regression.

`graph-revision` is a gate fixture rather than a manual showcase. `make graph-revision-gate`
builds a provenance-labelled production image, seeds the fixed corpus into an isolated volume,
expands the two benchmark seed notes with the deterministic benchmark-only filler corpus,
observes the resulting Markdown file count and bytes from that volume rather than trusting the
generator's constant,
starts it with `VECTOR_SEARCH=on`, `GRAPH_BOOST=on` and the compact e5 tier, then mutates one
source while graph health, graph-enabled search, an unrelated note read and HTTP heartbeat run
concurrently. A private non-wire observer on the production engine must show that the exact
source→target edge is absent before mutation and present in a later adjacency generation after
graph-enabled search. Adjacency completion and unrelated reads must finish within 1 s, health within
300 ms, no heartbeat may block over 1 s, and accumulated lateness must stay below 3 s. The same
command runs `node --expose-gc` in a separate container and records five baseline and
five post-fill heap/RSS samples plus structural cache counts. A second cold store proves that health
and adjacency join one load per generation; its warm one-note mutation then proves one write-through
parse, zero body reads, and metadata-only hits in both consumers. Reports live under
`test-results/graph-revision/`; no frozen latency or arbitrary memory baseline is imported.
The bare command infers `HEAD` only for a clean checkout. A dirty working tree fails closed unless
the caller supplies its frozen tree/checkpoint identity explicitly, so local reports cannot label
uncommitted contents as the current commit.

`context-open` is also the production-shaped Ability mutation stand. After seeding and starting it,
`BENCH_PHASE=pre BENCH_COMMIT=<frozen-commit> BENCH_IMAGE=<image-id>
BENCH_CONTAINER=<running-container>
BENCH_OUTPUT=/tmp/context-open-pre.json npm run bench:context-open`
captures the frozen baseline. The final gate is `BENCH_PHASE=post BENCH_COMMIT=<reviewed-commit>
BENCH_IMAGE=<image-id>
BENCH_CONTAINER=<running-container>
BENCH_BASELINE=/tmp/context-open-pre.json npm run bench:context-open`; plain
`npm run bench:context-open` is a post run too and fails closed without baseline and provenance. It
measures the existing Note/Context/Dashboard/graph-health surfaces and the seeded
`context-benchmark` Project Role through real MCP `get_ability`/`edit_ability`. The script mints a
temporary write PAT and always revokes it, records applied/no-op/stale-conflict raw samples, runs
unrelated-note and liveness probes alongside every edit, then repeats the user-surface bundle after
the mutation series. Reports land in `test-results/context-open-bench/` unless `BENCH_OUTPUT` is
set. Post runs enforce the 500 ms p95 / 1 s max bound on **every** measured operation — the applied
edit, the semantic no-op and the stale conflict alike, because the frozen defect hung a no-op — plus
the heartbeat bound. At the pinned twelve samples those two numbers are one: a nearest-rank p95 IS the
worst of twelve, so the 1 s bound restates the run's own abort rather than adding a second test, and it
regains independent meaning only at twenty samples or more. The before→after user surfaces are compared
by MEDIAN alone, against the greater of +20 % and +5 ms over the baseline median. There is deliberately
no relative p95 leg on them: judged that way a surface is judged by its single worst sample, whose swing
between runs of one unchanged image is wider than the allowance itself — on one recorded pair the leg
cried louder on a clean control run than on the same build under injected load. A distribution shift is
what the median leg is for; a lone worst sample still counts where it means something, inside the
absolute edit budgets. All three operations must actually have been
measured: a post report that publishes no stats for one of them, or whose cycles simply omit it, is
rejected by name rather than skipped, so the budget cannot be escaped by not measuring. The same
holds for the heartbeat series — absent stats are a named failure, not an unbounded pass — and for
the post and baseline surface stats, which are checked for sample count and finite non-negative
values before either side is compared. `ABILITY_TIMEOUT_MS` defaults to the 1 s
correctness bound, and a post report that was taken with any other timeout is rejected: the bound is
a property of the run, not of the numbers it publishes, so a looser abort would let a hung edit
resolve late and still read as bounded. Each measured call must also report the outcome its name
claims — applied → `applied`, no-op → `skipped`, stale conflict → `failed` — so a fast call that did
not do the work cannot pass as a fast edit. A frozen pre-fix server may therefore
record the edit timeout as a `pre` report without hiding the earlier surface baseline, while the
same timeout makes a `post` run fail. Commit and build time are read back from `/api/about`; image
digest, OCI revision and OCI created time are read independently from the healthy running container
with `docker inspect` and must match the runtime build; every stand-identity mismatch is reported at once rather than one throw at a time. `BENCH_COMMIT`/`BENCH_IMAGE` are expected
assertions, never report fields. The frozen pre report is accepted only for the exact
`main@5ce60d45` 1 s `AbortError` shape and must be the unchanged passing output of this harness.
A baseline file that carries no ability-edit section at all — an older or foreign report — comes back
as a named failure rather than a crash. The data-root fingerprint is derived from stable
project/memory/note/Role ids.

`npm run bench:context-sets-cost` is the provenance-bound #406 harness. Its frozen pre
must run on `5edc7b3`, prove that add-many is absent, and record manager/reorder/eager plus
idle-heartbeat samples. Every post bulk sample creates a fresh empty set outside the timed
interval, applies the same 1000 normalized refs in one request while health pulses run,
validates `added=1000` and membership 1000, and deletes the temporary set in `finally`.
The data-root digest includes the project, heavy set membership and pin/set order; driver
tests, not REST diagnostics, own transaction-attempt and update-count evidence. Reports
must contain a positive sample count, derived statistics must match their raw samples,
and every applied bulk sample must contain its own repeated heartbeat sequence. The
liveness envelope is evaluated from server-observed health-handler durations plus the
first/inter-handler/tail coverage gaps inside the bulk server interval. That interval begins
in the route's `onRequest` hook, before Fastify parses the 1000-ref body or runs pre-handler
authorization, and ends after response serialization; parser/auth CPU starvation therefore
cannot hide outside the proof. Client heartbeat duration remains diagnostic only, because host
scheduling after a completed response is not server event-loop starvation.

**Combining.** `CASE` accepts a comma-separated list — the cases **compose** into a
single stand: spaces are merged by slug, users/projects/members are deduplicated,
logical note ids are namespaced by case, path collisions are suffixed (nothing is
silently overwritten).

`make seed` = **stop → wipe data root → in-process seed → build+start** (the engine
holds meta.db under WAL, so seeding runs while the server is stopped, directly into the
host-bind `docker/volumes/data`). Env without Make: `CASE`, `SCALE`, `SEED`, `NOW`,
**`DATA_DIR`**, `SEED_USER`/`SEED_PASSWORD`/`SEED_DISPLAY_NAME`. The seeder takes paths
from **the same resolver as the server** (`dataPathsFromEnv`, [a single data-root](architecture.md#data-root)),
not from its own copy: it writes exactly the files that the stand later reads, so a
divergence would seed one stand but bring up another.
For a provider case, the same world also supplies the dev runtime's
`PROVIDERS_ENABLED` and exact `PROVIDERS_PRIVATE_ORIGINS`: `providers-disabled`
therefore starts with populated encrypted rows and no provider routes/tabs, while an
unrelated case keeps the checkout's ordinary `.env` values.
The default login for the stand is **`admin` / `admin`** (see «Login» below).

`tree-sort` is the deliberate exception with its own `sam` / `seed-pass` user and personal memory. On the real file-backed stand, authored `createdAt` is exact, while absolute `modifiedAt` may cluster around seed time because the engine observes filesystem mtime. The replay order still makes relative Modified ordering deterministic; the case tests that ordering, not the displayed wall-clock value.

### The `identity-collision` filesystem seam (#327)

The same shape as `external-edits`, for the other bug that only exists outside the
store: two spaces whose files claim ONE `notarium-id` — what copying a vault folder
produces. It cannot be a timeline `edit` either; a write through the store would just
mint a second id. The real applier writes both notes normally, then replaces the
claimant's `notarium-id` frontmatter with the id the owner actually got
(`externalIdentityClaims`, resolved after replay because neither id exists before it).
Both ids are 12 chars, so the rewrite rides the same size + mtime-preserving helper.
The stand then boots onto a live collision, and the arbiter has to settle one owner,
converge the claimant's file onto its own id and keep that answer across polls
([identity](core.md#identity)).

The FAKE stand does not project the collision: it has no arbiter to run, so it can
only show the converged end state — two notes with two distinct ids, which is what the
fixture already carries. Only the real stand exercises the repair.

What the fake CAN show is what the repair leaves behind. The claimant's timeline
carries a revision marked `unavailable` — a journal **gap** (#327) — followed by an
ordinary edit, so the Activity surfaces built for that state (the neutral feed row,
the `unavailable` heatmap bucket) are visible on a stand instead of only in a unit
test. The flag lives on the `edit` event and is honoured by the FAKE applier alone: a
quarantine is decided inside the real meta-DB's settlement transaction, so the real
applier replays an ordinary edit and lets the arbiter reach that row itself. The pair
of rows is deliberate — the gap and the edit AFTER it sit on a note whose trusted past
is gone, and telling them apart is exactly what the stored entry role does
([note-history](note-history.md#model)).

### The `external-edits` filesystem seam (#267)

This case deliberately cannot be expressed as another timeline `edit`: that would
exercise `store.write`, while the bug lives in files changed outside Notarium. The
real applier first writes `External edit probe` normally, then rewrites its physical
markdown file in place **without calling the store**, changing `stale-token` →
`fresh-token` and `[[Target A]]` → `[[Target B]]`. Both replacements preserve UTF-8
byte length; the helper restores the original mtime and asserts that size + mtime are
unchanged. The seed process has watch/poll disabled and stops immediately afterward,
so the production server started by `make seed` has to repair list/search/graph through
the real external-change reconciliation path.

Exact timestamp restoration uses POSIX `touch -r` without a shell because Node's
floating-point `utimes` loses sub-microsecond precision. The current `make seed`,
`npm run seed`, and helper test execute this script on the development host, so POSIX
coreutils are an explicit requirement of it (any ordinary Linux or macOS toolchain
provides them).

The fake projection applies the same replacements to its final snapshot so both
stands display the same final content; it does not pretend to exercise a filesystem
watcher or add an authored activity row. Targeted engine tests cover all three real
recovery routes: LocalFS change-token, exact watcher-path forcing, and a missed event
recovered by the persisted bounded integrity sweep.

### File shapes no write can produce (`externalSources`)

The same case carries a second seam, and it exists because the #267 one deliberately
cannot stretch: `externalRewrites` requires every replacement to preserve UTF-8 byte
length, which is what makes it model an editor that changes content without changing
size or mtime. Three shapes this project has to answer for cannot be planted that way —
an encoding prologue adds three bytes, a leading blank line adds one, and the complete
CRLF storage form must control every terminator rather than replace equal-size tokens.
Loosening that contract would delete the very thing it pins, so `externalSources`
declares WHOLE FILE bytes instead and deliberately changes size and mtime: it models an
ordinary external edit, and the engine is expected to notice it.

`{{noteId}}`, `{{path}}` and `{{createdAt}}` substitute exactly as they do in
`revisionStates` — the same helper, not a second copy. The applier runs AFTER
`externalRewrites`, so a size-preserving replacement still finds its occurrence in the
bytes the timeline wrote.

The `external-edits` case declares three stable file surfaces:

- `external/byte-order-marked.md` — a file a converter led with a UTF-8 mark. An
  ordinary save must not drop that byte: the mark is a property of the file, not of
  anything Notarium projects.
- `external/rule-led-prose.md` — prose that opens with a `---` thematic rule. The planted
  file has a separator blank before it, and after read normalization the shared BODY
  predicate still keeps the record-less block as content. The opening paragraph must
  survive an export with `frontmatter=strip` and must appear in the card preview.
  Reading normalises the one separator blank before the body, but the shared body reader
  still classifies the rule-fenced paragraph as content. Repeated Save must therefore keep
  both rules and both prose lines byte-for-byte; this is no longer a one-shot state.
- `external/crlf-preserved.md` — a complete storage-form note: CRLF frontmatter with a
  quoted title, indented `tags:` list and substituted `notarium-id`, followed by the
  canonical CRLF title heading and body. Change `Body line two.` through `edit_note
  findReplace`; only that physical line may differ, and a repeated no-op Save is a byte
  fixpoint. The web editor is not the EOL gate because it normalises body line endings.

**Real applier only, and this is a border rather than a gap.** The fake stand has no
files at all, so it shows these notes as their ordinary timelines left them; a byte-order
mark and CRLF terminators are byte facts, while the fixture specifies normalized note
state. `toFixture` validates the handles and applies nothing, which is the same honest
split `externalIdentityClaims` already documents above. Only the real stand can plant the
shape and prove the engine's answer to it.

### The `jobs` axis — export artifacts (#105/#101)

The `jobs` case seeds durable jobs: an archive ready for download, one expired by TTL, a
failed one, and a canceled one. The applier **invents nothing** — it does `enqueue` →
`claim` → and runs the **production export handler** against the real store, so the
archive is a genuine ZIP of the seeded notes under `<DATA_DIR>/jobs`, and its size is
measured, not made up. The side effect is intentional: `make seed` became a live check
of the data-root — that very surface (#101) was silently failing in production, because
the path to the artifacts was a forgotten env, and no seed touched it.

The same case also declares one retrying durable import. The real applier streams
its bytes through `createFsImportStagingStore`, exercising the production
`.import.part` → `.import` atomic promotion under `<DATA_DIR>/jobs/imports`, then
creates and reschedules a real import row with a deliberately distant retry instant.
Normal row-aware maintenance therefore retains the upload, making the state stable
for backup/manual QA instead of relying on the short pre-enqueue orphan grace.

The generic export declarations expose only **terminal** states: a runnable seeded
`pending` export would be claimed within one poll, while a backdated `running` one
would be reaped and driven to completion within one maintenance tick. The durable
import above is the intentional non-terminal exception: its real `run_at` lies in the
future, so it is live for maintenance and backup but not runnable on the QA stand.

Real-applier only, like `connectedApps`/`retrievals`: the fake backend has no job layer,
so e2e/visual do not render these rows. In the UI (Settings → Export) `useExportJob`
adopts on mount only **succeeded with a live artifact** → «Archive ready»;
`failed`/`canceled`/expired ones are honest history for the API/list and GC, but the tab
does not show them.

## Login (default login)

The seed always creates an **init user** and prints it as a large banner at the end
(`make seed` shows `URL + login` as the last line; the same line is in the resulting
JSON). **The default is `admin` / `admin`**, and it is also the author of the seeded
content (the canonical-owner `sergey` in the cases is mapped onto `SEED_USER`), so «my»
heatmap/feed work out of the box. Multi-author cases carry a second author `alex`.

The value is fixed and identical across all checkouts — whoever brings a stand up
knows how to log in **without asking or making up a password**. It is overridden via env (only when
needed):

| Variable | Default | What |
|---|---|---|
| `SEED_USER` | `admin` | the init user's login (= content author) |
| `SEED_PASSWORD` | `admin` | password (or `make seed … PASSWORD=…`) |
| `SEED_DISPLAY_NAME` | `Admin` | display name |

## Extensibility (contract)

A note declaration and an explicit timeline `edit` can carry **`frontmatter`** — the keys an IMPORTED/external Markdown file arrived with,
authored as bare YAML lines without the `---` fences (#280) — so a seeded "imported note"
keeps its author's keys instead of a seeder-only imitation of the outcome. The two appliers
reach it by their own routes, as everywhere else: the REAL one through the production
`WriteInput.frontmatter` channel (`scripts/seed.ts` → `store.write` → the file's own block),
the FAKE one through `NoteSnapshot.frontmatter` → `InMemoryStore.load` (a fixture is a
snapshot, not a replayed write). Both must land the same note, and the fake's load derives the
same typed projections from the final carry as its write does (`type`/`tags`/`aliases`/`slug`/
`summary`/`muted`). Explicit fixture fields have the serializer's final priority, including
empty clears, and remove their raw shadow so it cannot reappear on export. Skipping either rule
would make the fake disagree with the real file after import (pinned by `inMemoryStore.test.ts`).

A space declaration may carry **`fieldSchema`**. It is outside the note timeline: the
real applier publishes `.notarium/fields/schema.yaml` through the production CAS service,
and the fake seeds the stateful in-memory counterpart consumed by the same REST routes. A
schema never fabricates a note, journal row, or index event.

A create declaration may additionally carry typed **`sourceLocator`**. Both appliers materialize it through the same trusted `WriteInput.sourceLocator`/`NoteSnapshot.sourceLocator` channel, so the file contains reserved `notarium-source` while ordinary frontmatter/public projections do not. This is distinct from authored `frontmatter`: putting the same key there models fresh untrusted carry and must not mint a claim. Omitting `sourceLocator` is how a case deliberately preserves a source-less legacy import state.

Ordinary seeded history remains a readable compatibility projection: the fake writes a
complete canonical `markdown-v1` snapshot and hashes/diffs that snapshot, not only the
body, while the real write/read-back produces the current byte-safe format. `history-rich`
contains one body-stable raw edit that changes
`review-status: draft → reviewed` and `tags: [release] → [release, reviewed]`; this keeps
metadata-only CAS/history/diff and raw-to-typed projection parity reproducible on both appliers. Low-level `ActivityFixture`
may omit `snapshot`; that omission intentionally creates a legacy body-only row for UI/API
compatibility tests and is never treated as a current full revision.

States that cannot honestly pass through a normal authoring write use the neutral
`revisionStates` declaration. It names a timeline note and an authored date, then chooses
`gap`, legacy body-only, or byte source (`utf8|base64`) plus document role/path fallback,
skill directory and synthetic receipt-bound owner claims. Both appliers call the same
`DocumentState` analyzer/codec, including exact `{{noteId}}`, `{{path}}` and `{{createdAt}}`
token substitution. Duplicate `(note,date)` declarations must be byte-identical;
incompatible duplicates fail, and combined cases namespace note dependencies while
preserving declaration order.

### Owned Agent Skill states

`agentSkills` declares one Personal/Space `home` plus manifest intent, never a storage path or id.
A Space home declares `availability:all-projects|selected-projects`; selected declarations name
project references which each applier resolves to stable ids in the same Space. There is no
Project-target compatibility form. A Custom declaration provides `name`, `description`, and
optional instructions. `source:'catalog'` runs the direct Skill Add path and retains provenance;
`source:'role-dependency'` instead selects the exact supporting package already installed by an
earlier `agentRole` and cannot create a same-name substitute. Optional `roleTarget` addresses a
different exact role placement without changing skill ownership — which is what a catalog Add on a
PROJECT placement produces, since a project is no skill home and the dependency lands in the Space.
Both are seeded by `agent-abilities-rich`, TWICE: once where the project sits in a shared Space
(the dependency lands in that Space) and once where it sits in a project of the owner's PERSONAL
space, where Personal is the space's own root and the dependency lands in the personal library
instead. The second is not a repetition — it is the only seeded state in which a role with a
dependency lives in a project of a personal space, and it is what keeps a seeder answering "no
personal space" for such a placement visible: the Add then writes the role's only link as
`[[notarium-id:space:…]]`, an address the locator seam refuses, while the seed still reports ok.
Declared-but-unseeded is how an applier branch stays dead, so the pair is exercised by the same
run that seeds the stand. `renameTo`, `linkedRole`, and
`deleted` operations run in that order, making rename-stable links and a deleted broken reference
durable fixture states without adding a product UI for role composition.

A Custom skill may carry `agentAudit` and legacy `pins`. The real applier then uses the same durable
ability creator as MCP/REST — including strict publication, terminal identity/revision/reach commit
and session attribution — rather than stamping `principal:'seed'`. Pins are written only after the
creator returns the settled note id; package id remains the role/runtime address. The fake keeps the
same final package shape but does not invent durable meta-DB audit rows.

`agentRoles` declares either the catalog Add path or `source:'custom'` with its complete authored
instructions. Roles retain Personal/Space/Project placements; Custom creation supports all three.
A Space target may declare `availability` in the same shape a Space skill does — it is refused on a
Personal or Project target, which have no reach to narrow, and on a catalog Add, whose operation
carries a destination and nothing else. `deleted:true` removes the exact published package through
the same journaled directory operation, so the role is absent from inventory and present in Trash.
`attachRole` attaches ANOTHER role by exact locator where a skill belongs — the one route to the
`wrong-kind` attachment health — and resolves against a Personal or Space role declared earlier in
the same Space.

`agentAbilityPreferences` declares the owner Enable/Disable overrides. Each row names an owner and
one ability: a System package by manifest name, an Owned one by the placement that published it.
Catalog packages cannot be activated and are refused. The facet is sparse in the product and in the
declaration alike — anything undeclared stays enabled, which is what an absent row means at
runtime, and two owners may disagree about the same shared ability. Both stands resolve a
declaration through ONE applier (`test/cases/applyAbilityPreferences.ts`), the way they already
share the role, skill and availability appliers; a host supplies only its own clock and its own
preference facet. The rows the REAL applier writes are read back out of the seeded meta-DB by
`test/cases/agentRolesRealSeed.test.ts` — the count the seeder reports says nothing about what
landed in them.

That same combined row also carries the Project-Role identity proof: a role published under the
reserved `_projects/<encoded-project>` root must have a manifest whose `notarium-id` equals the
`note_identity` row for the same file, since that id — not the directory — is what a rename, a
restore or an exact locator resolves. The proof rides the abilities-merge seed that row already
runs, deliberately NOT a second seed of `context-open`: that case's corpus is fixed at 1100 + 2700
notes (`SCALE` moves only the project-memory count), so a real run of it costs ~85 s on its own and
times out under a loaded `make checkup`, while the placement it would demonstrate is the same one.
That `context-open` declares exactly one Custom Project Role in `context-lab/product` is asserted
against the case world in `test/cases/cases/contextOpen.test.ts`, in milliseconds.

The bundled inventory is part of every seeded stand: `research` plus `research-evidence` are
System, while `grooming` plus `grooming-evidence` are Catalog. The `agent-roles` case combines that
split with same-name Owned research placements, exact System lookup/toggle coverage, a renamed
dependency, a missing dependency produced by permanent package deletion, and Space availability
edges — including `launch-review`, a Space role reaching two of the five Team projects, which is
the state a second copy used to stand in for, and `field-guide`, a project role with no Space base:
the one shape a promotion can land without meeting its own name. The remapped default stand owner also receives `release-reviewer` plus a role-only pin, so
manual QA can compare Base Context with an exact Role context without changing accounts. System
packages are never copied or mutated by the seed appliers.

Both appliers call the same `applyAgentSkillDeclarations` helper through production
`RolesService`, `RoleLibrary`, and `KnowledgeStore` seams. Add/Create mints the note id first; the
configured library derives the package directory from it. Subsequent rename/link/delete address
that exact id and derive the package root from the live note, so neither `.notarium/skills` nor an
embedded mount prefix leaks into the declaration. The fake RoleLibrary is backed by the same
in-memory store as note routes; package and editor mutations therefore cannot diverge into two
maps. Every seeded root is parsed as a valid Agent Skills manifest before publication.

The direct recovery fixtures follow the same positional validity. `restore-states` keeps its
opaque UTF-8 root invalid with an illegal manifest name, and `trash-recovery` keeps its imported
helper opaque the same way, because that is the only route that carries the state: `description` is
optional, so omitting it still projects a perfectly valid package, and a manifest name is not
required to match its directory.

- **+content edge case** → add a `Fragment` to `corpus/<feature>.ts`. It flows on its own
  into the reader cases + the coverage matrix + the honesty test.
- **+case** → a new file in `cases/*` (exports a `CaseSpec` with `axes`) + a row in
  `registry.ts`. Both appliers and the CLI will pick it up.
- **+axis** → a row in `axes.ts` (the coverage test will see it) **and the same axis added
  to the count and the list in [Axes and coverage](#axes-and-coverage)**. The test sees a
  new row; nothing sees that sentence, so it is the half that rots — `fields` (#384) landed
  with the count still reading 19 and the axis missing from the list.

## Appliers (details)

- **Real** (`scripts/seed.ts`): a SpaceManager with `createStore→CachedStore({now: ()
  => clock})`, the engine's fs-watcher (#146) disabled (otherwise the read-model
  reconcile would re-journal our own writes as false `external`), the replay grouped by
  space. `create`→`store.write`, `edit`→`store.write` (a CAS chain), `delete`→`store.remove`,
  `restore`→`store.restoreFromTrash` (an honest `kind:'restore'` revision), an
  `externalRewrite`→a same-size/mtime direct markdown write after the timeline, an
  `archived` space→`manager.archive` after the seed (moves to Trash→Spaces, data intact).
  Provider declarations mint the canonical credential keyring before the first
  ciphertext, then run through `ProviderRegistry` and production persistence. The two
  deliberately impossible product states (origin mismatch and a carrier naming a lost
  key) are applied after the normal write through a backend-specific raw transaction;
  SQLite and PostgreSQL receive the same final record.
  Declared `revisionStates` are appended through the production revision persistence after
  the ordinary timeline, with the real note id, expected-head CAS, encoded bytes, semantic
  fingerprint and persisted restore safety.
  Owned roles are applied through catalog/custom create and optional package delete before
  `agentSkills`; the shared skill applier then performs Custom/direct catalog Add, exact dependency
  rename/link, availability binding, package delete mutations, and agent-attributed durable Custom
  publication against the configured skill mount.
  Agent delta cursors resolve their declarative `throughNote` anchor to the real latest
  revision id only after the timeline exists, then advance through the production meta-DB
  persistence. Declared Enable/Disable overrides are written last, against the exact
  package ids the appliers just published — the facet is sparse, so only declared rows
  exist and everything else stays enabled by absence. Zero edits to production code.
- **Fake** (`caseToFixture`): a fold of the timeline → `Fixture` (a snapshot of live
  notes + activity rows); a note whose last op is `delete` — only a tombstone row.
  Declared `revisionStates` become the same encoded bytes (base64 only as the fixture
  carrier), format/fingerprint/safety and gap marker in the in-memory journal.
  Agent packages are then applied to the live in-memory store, not a parallel package-only map.
  Meta-DB-only delta cursor declarations are intentionally real-applier-only; the fake has
  no revision ids to which their semantic anchors could honestly resolve. A session's exact
  role locator is not carried in the fixture either — package ids are minted at publish
  time, so the fake applier resolves it from the declared role name once the packages
  exist, the same way the real seeder does.
  Owner Enable/Disable rows ride along in `agentAbilityPreferences` and are applied
  last, exactly as on the real stand — resolved against the ids the two appliers just
  minted, and refused with the same `ability preference references an unpublished …`
  when a declaration names a package nobody published. This used to be a caveat
  ("the fake does not express Enable/Disable"), and it was the reason no browser gate
  could START from a disabled ability — it could only click one off. Proven end to end
  in `test/fake-server/seedCatalog.test.ts`.
  Provider declarations use the same shared applier. The fake mints a temporary
  filesystem keyring through `CredentialKeyringService`, stores real envelopes in its
  strict in-memory persistence, applies the named raw corruptions only after a valid
  create, and archives target Spaces through the real `SpaceManager` lifecycle.

## Deliberate caveats

- **Space archive is expressed by both appliers.** The fake creates an archived case
  Space as a runtime (not config-pinned) Space, seeds its rows, then calls the same
  `SpaceManager.archive` lifecycle as the real applier. This is required for provider
  resolution to keep an accepted attachment and return `space-archived` rather than
  silently serving the target as live.
  - *Blob readability* used to be listed here too — it is also no longer a caveat
    (#256). The fake
    projection now stamps every seeded revision with the body it carried and
    content-addresses it into the blob table, exactly like a live write, so a
    tombstone keeps the note's last known content. Two things fall out of the same change: a seeded revision chain
    is READABLE (the history panel's revision view and the Changes diff fetch by
    `contentHash` — before this they showed "body unknown"), and each row carries
    real `charsAdded`/`charsRemoved` rather than null — stamped the way the journal
    stamps them PER OP: `diffStats` against the chain parent for a write, and for a
    tombstone the journal's own rule (`0` / the removed body's length), not a diff
    of the body against itself. Strict restore durability itself is intentionally absent
    in the fake tier: public rows report `capability-unavailable`, `restorableTotal=0`,
    and restore endpoints answer 503 rather than simulating a weaker success.
- **The fake does not express whole-file byte shapes.** An encoding prologue and a
  leading `---` rule are facts about bytes on disk, and the fake tier has no disk. The
  notes seeded with `externalSources` therefore appear normalized there while the real
  stand carries the declared bytes. Trying to "express a BOM in the fixture" is out of
  scope by construction, not an unfinished job — the store contract already tolerates
  the divergence on purpose (`storeContract.ts` strips a leading mark before asserting
  a file opens with `---`).
- **Fake activity rows are keyed to the note they describe.** The projection stamps
  each row with `physicalIdOf` — the case's pinned physical id when it declared one
  (#302, above), else the id the in-memory store derives for that path — not the
  catalog's logical handle (#256). With the handle the aggregate
  surfaces still worked (heatmap, feed) but every PER-NOTE lookup came back empty on
  a world that demonstrably had revisions. The id rule is imported from
  `@notarium/engine-memory`, not restated, so the two cannot drift.
- **An emoji-only title is not seeded** (#296). Its file is named after the NOTE
  (`<id>.md`), and the id rung is settled by the write itself — but a case declares
  each note's path up front and the applier pins it as the write's `fileName`, so a
  seeded path could not agree with it and the two appliers would disagree about a
  state neither is wrong about. The `non-latin-names` case seeds every state that
  DOES survive the round trip (five scripts in one folder, a uniquified pair,
  cross-script links, a lone non-Latin ghost, a CJK folder); the id rung is covered
  where it survives — the store contract on all four engine legs, and
  `test/unit/cachedStoreMutations.test.ts`.
- **The `attachment` / `derived` / `encrypted` classes are not seeded** — these are
  engine mounts for derived/encrypted data, not user content (a future iteration if
  needed). What is seeded: `user-doc` / `agent-memory` / `profile` / `skill`.
- **The generic fake projection does not express context sets (#209), cross-space loose pins (#209), and order (#210).**
  The fake's snapshot carries no stable note-id that a set item / scope pin / order entry
  refers to — so `world.contextSets`, `world.scopePins`, and `world.contextOrder` are
  projected only by the REAL applier (`scripts/seed.ts`, which has a logical→real map;
  order references pins by logical note-id and sets by NAME, and is resolved after the
  sets are created). A test that needs a large prebuilt set may opt into the fake app's
  injected `contextSets` + reset-aware `seedContextSets` seam; it runs after live identities
  and projects exist and uses the in-memory engine's exact raw-file accessor for real
  `CachedStore.noteFacts`. Generic `toFixture` remains unchanged. All three surfaces are exercised through the fake's REST instead, by
  the conformance suite under `test/fake-server/`
  (`contextSets.test.ts`, `scopePins.test.ts`, `contextOrder.test.ts`).
- **Scope order (#210) = `b.contextOrderFor({scope, entries})`** — `entries` in the
  desired order (`{kind:'pin', note:<logical id>}` / `{kind:'set', name:<set name>}`),
  pins and sets at the same rank (a set can be placed above a pin). A partial order is
  fine: anything unmentioned falls to the default tail (self-healing). The `agent-context`
  case places `Frontend Canon` at the TOP of personal + project (the exact story of the
  issue «I drag a set to the top»).
- **A markdown file the index has never seen is not seedable.** The create-collision
  refusal has two layers, and the engine's (disk truth, no occupant identity to name —
  [note-model.md](note-model.md#create-collisions)) needs a file that exists on disk while
  being absent from the index. That state cannot survive `make seed`: the server's boot scan
  indexes any planted file before the first request, so it would arrive on the stand as an
  ordinary note and prove nothing. It is covered where it does survive — the filesystem leg
  of `test/unit/cachedStoreMutations.test.ts`, which plants the file under a live store.
- **The honesty test requires `jsdom`** (in isolation, via a docblock) — the only place
  with a DOM under `test/`; the rest of that tree is node-only, while `packages/web`
  brings its own jsdom docblocks to the same run.
- **Favorites (#42/#245) are seeded only by the REAL applier.** The `favorites`
  declaration (`{kind: note|folder|project, ref}`) mints `favorites` facet rows via
  `store`/`ensureFolderIdentity` (a folder-favorite lazily mints a folder-identity, like
  the server-side add-to-favorites); note→real id, project→project id, folder→folder id.
  The fake projection does not express them (no field in `Fixture`) — e2e/visual seed
  favorites through the live API (`PUT /api/s/:space/favorites`), see
  `test/e2e/files-feed-favorites.spec.ts`. Verified live.
- **Connected apps (#181) are seeded only by the REAL applier.** The `auth.connectedApps`
  declaration (appName / scope / spaces-slugs / age) mints an oauth client + a live
  access+refresh pair (only secret hashes, spaces → stable-id), so Settings → Connected
  apps shows real connections with narrowing. The fake projection does not express them
  (no field in `Fixture`) — e2e/visual do not exercise them; if needed — a future
  iteration. Verified live.
- **Pending OAuth clients are seeded only by the REAL applier.** The
  `auth.pendingOAuthClients` declaration writes registrations that have not crossed
  consent yet (`activated_at = NULL`). They consume the bounded public-registry budget,
  expire after 24 hours, and intentionally do not appear in Connected apps. `multi-space`
  carries a fresh DCR example alongside its two activated integrations.
- **Agent sessions and their audit (#243/#321).** `world.agentSessions` declares durable
  episodes; ids are derived from `ref`, `parentRef` preserves forks, and
  `project:{space,path}` resolves the sticky project hint to the same durable project id in both
  seed projections. A selected role is resolved in that project and records the matching role
  context; omitting `project` keeps the Personal/default state. `retained:false` removes only the
  lifecycle row while keeping its captured audit as an
  archived session. A retrieval (`WorldBuilder.retrieval`) and a timeline write
  (`event.agentAudit`) may bind to an episode with `sessionRef` plus
  `sessionAttach: declared|inferred`; omitting the ref deliberately places the event in
  **Outside sessions**. A bound event always inherits the session owner. An explicit
  conflicting event owner is a seed error rather than an impossible cross-owner state.
  Retrievals are written by the REAL applier after timeline replay, when their LOGICAL
  hit refs can resolve to real id/title/class; empty `hits` is a zero-result MISS. The
  fake projection carries retained session lifecycle rows and agent-attributed journal writes
  (including archived/Outside snapshots) through the same audit tap as live writes. Retrievals
  remain a real-stand concern — so a state carried only by them, such as the five-label Agent
  facet in `agent-sessions`, is reproducible on a seeded stand and invisible to the fake, where
  a spec supplies its own facet through `page.route`. `agent-context` demonstrates aggregate
  query/miss data; `agent-sessions` covers root/fork/automatic/archived/Outside episodes, a page
  boundary and a cross-source timestamp tie, read+write timelines, owner isolation, an owner with
  no activity, a quarantined unavailable write, hostile strings, and max-length labels.
