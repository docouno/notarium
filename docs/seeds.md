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
3. **Axes + coverage matrix** (`axes.ts`, `coverage.ts`) — 19 product axes, each tied to
   surfaces + a canon doc; cases tag `axes`. `make seed-coverage` prints the matrix; the
   coverage test fails on a gap.
4. **Appliers** — `caseToFixture` (fake) and `scripts/seed.ts` (real). The case model is
   a neutral **timeline** of events, from which BOTH projections are derived.

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

**Honesty test** (`corpus.honesty.test.ts`, the only one with a `jsdom` docblock, since
DOMPurify is needed): for each fragment — «does not throw + non-empty», `contains`/`excludes`,
and for `security` — it parses the sanitized HTML into a live DOM and checks that no
`<script>` / `on*=` handler / `javascript:` URL survived. The rest of the suite stays node-only.

## Cases

**Structure / spaces / folders / classes:**

| Case | About | Axes |
|---|---|---|
| `multi-space` | 3 spaces + a personal domain with memory + **live/archived/shadowed/ambiguous space aliases** + **archived scratch** + a **zero-grant recovery user** + **connected apps with narrowing** + **pending OAuth registration** | structure, agent-memory, auth, note-classes, trash, identity |
| `folder-page` | `index.md` pages (nested), children summary, breadcrumbs (#212-214) | folder-page, structure, content |
| `note-classes` | one note per class — visibility matrix for user-doc/agent-memory/profile (#78/#74) | note-classes, agent-memory, structure |
| `explorer-scroll` | a deep tree: a note near the bottom + many collapsible folders above — the explorer scroll-position invariant (#242): a reflow above the open note does not move the scroll | structure, scale |
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
| `history-rich` | a deep revision chain, 2 authors, rename (#203/#160) | history, identity |

**Graph / identity / search:**

| Case | About | Axes |
|---|---|---|
| `wiki-web` | a dense wikilink graph, alias/ghost (#202/#100) | graph, identity, content |
| `graph` | hubs/orphans/ghost-by-refcount/former-name/cross-folder communities (#38/#202) | graph, identity |
| `graph-load` | scalable linked communities: 300 nodes / ~900 links per scale unit; `SCALE=10` reproduces the 3k/9k cold-enrichment workload (#195/#284) | graph, scale |
| `search-corpus` | a spotlight corpus: same-named notes, content/path-match, tag case-fold (#188/#204) | search, content |
| `external-edits` | a direct same-size, mtime-preserving markdown rewrite: search marker + graph edge must self-heal on server boot/poll (#267) | search, graph, content |
| `identity-collision` | one `notarium-id` planted in two spaces on disk: the arbiter must leave a single durable owner and re-mint the loser on the next boot (#327) | identity, structure, history |
| `name-collisions` | the states that flow from "a title picks the file name": a folder primed for the refusal dialog, an already-uniquified `Retro`/`Retro 2`/`Retro 3` family, the same title in two folders, and a folder page whose reserved `index.md` deliberately does not collide — [note-model.md](note-model.md#create-collisions) | identity, structure |

**Content / reader:**

| Case | About | Axes |
|---|---|---|
| `reader-showcase` | a note for EVERY markdown feature, assembled from the corpus | content, note-classes |
| `long-document` | the entire corpus as one long note — reading-size/outline/scroll/diff (#27/#189) | content, scale, history |

**Public demo (#256)** — the one case whose output is a published artifact:

| Case | About | Axes |
|---|---|---|
| `demo` | a self-hosting developer's knowledge base (architecture / decisions / runbooks / an incident) — the source for the landing-page, README and docs-site screenshots. Strings live per-locale in `test/cases/demo/`; the case owns only the shape. Carries ONE agent-signed revision on purpose (the history frame). Shot with `make demo-shots` — see [demo-screenshots.md](demo-screenshots.md) | content, structure, history, activity, graph, search, auth |

**Agent memory / import:**

| Case | About | Axes |
|---|---|---|
| `agent-context` | pins + personal/project memory + projects of varying density (#165), including the pinned `product/index.md` **Folder overview #311**; **heavy pins over budget + a `Budget Lab` space for all token-budget cases #208** (personal-trim, fits / squeeze / dominant / no-pins — nesting the personal set into project Q's budget); **cross-space context set #209** (`Frontend Canon` in the `Conventions` space, connected to project Product OS + personal) **+ cross-space loose pin #209** (`Security Baseline` from `Conventions`, pinned directly into Product OS + personal) — both resolve cross-space; **retrieval audit #243** (search/recall/get_note history: hits + a recurrent vocabulary-mismatch miss + frequent queries) | agent-memory, agent-audit, structure, note-classes, scale |
| `agent-sessions` | session-first audit: active fork siblings, exact call vs audited read/write counts, declared/inferred attachment, `Outside sessions`, an archived snapshot whose lifecycle row was GC'd, hostile and max-length unbroken labels, owner isolation, and distinct root/fork/owner delta positions | agent-sessions, agent-audit, auth, history |
| `agent-roles` | five principals keep the boundary visible: Fresh is catalog-only; Bob owns an idle Personal fork; Maya owns switchable Personal `research`/`grooming` presets plus same-name Research Space + two Project forks; Robin can inspect the Team role read-only. Base Personal/Project pins remain visible, each placement has a distinct role pin, the Team Project role adds a set plus an oversized tail that trims under the shared `Role → Project → Personal` budget, and an active episode rehydrates `research`; Sergey remains the browsable real-stand owner | agent-roles, agent-sessions, auth, structure, scale |
| `memory-perf` | 2700 ordinary notes + 4 personal-memory categories + 1 project-partition sentinel; reproduces memory-mount scaling, partition isolation, and graph-inert memory links | agent-memory, note-classes, scale |
| `import-thread` | one rich imported thread | import, content |
| `import` | a multi-format layout (claude/chatgpt/memory-json) + backdated dates-as-data → Feed year-spread (#11/#223); plus `dropped/` — the states of a dragged-in `.md` archive whose OWN frontmatter was lifted (#280): authored tags + date, an Obsidian note titled by its file name with `aliases:` and plugin keys kept, a Jekyll post whose `title:` beats a differing body `# H1`, and a frontmatter-less note dated by the file's mtime | import, content, activity |

## Axes and coverage

19 axes (`axes.ts`): `content`, `structure`, `folder-page`, `activity`, `history`,
`trash`, `identity`, `search`, `graph`, `agent-memory`, `note-classes`, `import`,
`jobs`, `scale`, `auth`, `favorites`, `agent-audit`, `agent-sessions`, `agent-roles`. Each is tied to
surfaces + canon docs.

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
make seed CASE=dashboard-activity SCALE=1 SEED=x PASSWORD=secret
make seed CASE=reader-showcase,graph,trash-mixed    # COMBINATION of cases
make seed-coverage                                  # coverage matrix
```

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
The default login for the stand is **`admin` / `admin`** (see «Login» below).

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

A note declaration also carries **`frontmatter`** — the keys an IMPORTED file arrived with,
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

- **+content edge case** → add a `Fragment` to `corpus/<feature>.ts`. It flows on its own
  into the reader cases + the coverage matrix + the honesty test.
- **+case** → a new file in `cases/*` (exports a `CaseSpec` with `axes`) + a row in
  `registry.ts`. Both appliers and the CLI will pick it up.
- **+axis** → a row in `axes.ts` (the coverage test will see it).

## Appliers (details)

- **Real** (`scripts/seed.ts`): a SpaceManager with `createStore→CachedStore({now: ()
  => clock})`, the engine's fs-watcher (#146) disabled (otherwise the read-model
  reconcile would re-journal our own writes as false `external`), the replay grouped by
  space. `create`→`store.write`, `edit`→`store.write` (a CAS chain), `delete`→`store.remove`,
  `restore`→`store.restoreFromTrash` (an honest `kind:'restore'` revision), an
  `externalRewrite`→a same-size/mtime direct markdown write after the timeline, an
  `archived` space→`manager.archive` after the seed (moves to Trash→Spaces, data intact).
  Agent delta cursors resolve their declarative `throughNote` anchor to the real latest
  revision id only after the timeline exists, then advance through the production meta-DB
  persistence. Zero edits to production code.
- **Fake** (`caseToFixture`): a fold of the timeline → `Fixture` (a snapshot of live
  notes + activity rows); a note whose last op is `delete` — only a tombstone row.
  Meta-DB-only delta cursor declarations are intentionally real-applier-only; the fake has
  no revision ids to which their semantic anchors could honestly resolve.

## Deliberate caveats

- **The fake does not express space-archive.** In the fake's projection an archived
  space sits as LIVE (there is no field in `SpaceFixture`). On the REAL stand it is
  honest (the seeder calls `manager.archive`). Verified live.
  - *Restorable* used to be listed here too — it no longer is (#256). The fake
    projection now stamps every seeded revision with the body it carried and
    content-addresses it into the blob table, exactly like a live write, so a
    tombstone keeps the note's last known content and the trash is restorable on
    both appliers. Two things fall out of the same change: a seeded revision chain
    is READABLE (the history panel's revision view and the Changes diff fetch by
    `contentHash` — before this they showed "body unknown"), and each row carries
    real `charsAdded`/`charsRemoved` rather than null — stamped the way the journal
    stamps them PER OP: `diffStats` against the chain parent for a write, and for a
    tombstone the journal's own rule (`0` / the removed body's length), not a diff
    of the body against itself.
- **Fake activity rows are keyed to the note they describe.** The projection stamps
  each row with `deterministicNoteId(path)` — the id the in-memory store derives for
  that path — not the catalog's logical handle (#256). With the handle the aggregate
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
- **The fake does not express context sets (#209), cross-space loose pins (#209), and order (#210).**
  The fake's snapshot carries no stable note-id that a set item / scope pin / order entry
  refers to — so `world.contextSets`, `world.scopePins`, and `world.contextOrder` are
  projected only by the REAL applier (`scripts/seed.ts`, which has a logical→real map;
  order references pins by logical note-id and sets by NAME, and is resolved after the
  sets are created). In e2e all three surfaces are exercised through the fake's REST
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
  with a DOM in the suite; everything else is node-only.
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
  `retained:false` removes only the lifecycle row while keeping its captured audit as an
  archived session. A retrieval (`WorldBuilder.retrieval`) and a timeline write
  (`event.agentAudit`) may bind to an episode with `sessionRef` plus
  `sessionAttach: declared|inferred`; omitting the ref deliberately places the event in
  **Outside sessions**. A bound event always inherits the session owner. An explicit
  conflicting event owner is a seed error rather than an impossible cross-owner state.
  Retrievals are written by the REAL applier after timeline replay, when their LOGICAL
  hit refs can resolve to real id/title/class; empty `hits` is a zero-result MISS. The
  fake projection carries retained session lifecycle rows, while retrieval and archived
  audit snapshots remain real-stand concerns. `agent-context` demonstrates aggregate
  query/miss data; `agent-sessions` covers root/fork/automatic/archived/Outside episodes,
  read+write timelines, owner isolation, hostile strings, and max-length labels.
