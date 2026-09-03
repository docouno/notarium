# Home dashboard (#33, #216)

The home page (`/`, the “home” state) is the dashboard of the active space: a hybrid of **Activity** (what changed and when) and **Knowledge Overview** (what the base actually contains). It replaces the previous `Splash` placeholder in the home state; `Splash` remains for an empty folder / empty note and for an **empty base** (0 notes) — the dashboard degrades to it on its own, so that the first screen of a new space invites you to create a note rather than showing a grid of zeros.

As of #216, the top row of dead stats has been rethought into **tab tiles**: a persistent tab bar (three switcher tiles); a click takes you to a separate **surface** with full lists — topics no longer compete for space on a single canvas. The tiles are visible on all surfaces (the active one is accent-lit).

The dashboard is **space-scoped** and sits inside `DocumentLayout` (the topbar + aside remain; content is full-width). The composer is `packages/web/src/composers/Dashboard/`. Data rides on the read-model (#60) + the journal (#12) in two independent freshness lanes: `changed` refetches activity/events/projects/tags, while `graph` refetches graph + graph-health. Both are coalesced for 1 second, and one lane never cancels the other's in-flight response. This keeps the dashboard live without polling or turning every note save into two whole-graph reads.

## Container: one shell, surfaces in the Outlet (#216)

Home and its deep surfaces are **one nested route** under `/s/<space>`:

- **`DashboardLayout`** holds the read-model load (`useDashboardData`) and the tile bar; the active surface renders in its `<Outlet/>` (data is shared downward via `useOutletContext`).
- The layout sits on the shared route segment `/s/<space>`, so switching tiles (changing the child route) **does not remount the shell** — data survives the transition, the surface switch is instant and without flicker. This same thing makes the container **SHELL-compatible**: a future tab document simply wraps the route.

Routes (space-scoped, `routePaths.ts`):

- **Activity** = default = bare **`/s/<space>`** (Activity IS home — there is no separate `/dashboard/activity` URL; `/dashboard` and `/dashboard/activity` are canonicalized by a redirect to `/s/<space>`).
- **Projects** = `/s/<space>/dashboard/projects`.
- **Hygiene** = `/s/<space>/dashboard/health`.

`parseAppPath` classifies only the deep surfaces as `{kind:'dashboard',space,view}` (`projects`/`health`); the default Activity is parsed as `all` (it is home). `dashboardRoute(space, view)` builds the address: `activity` → `spaceRoute`, otherwise `/dashboard/<view>`. Navigationally, the dashboard surfaces behave like home (`nav.type:'all'`) — the rail keeps the home logo accent-lit, Files/Favorites do not light up.

## Tiles and reference numbers

Each tile carries an icon, a name, and a **metric**:

- **Activity** — “N this week” (`stats.week`).
- **Projects** — “N · K active” (total projects `useProjects` · active within the window from `/activity/projects`).
- **Hygiene** — “N to repair” (the number of broken links `health.ghosts`) + a **danger severity dot** when there are broken ones; a healthy graph → “All clear”, the dot is calm.

Below the tiles is a thin **reference row** (`notes · tags · links`): the stats that the tiles do not carry. “links” is a deep link into the graph (the connectivity surface).

## Activity — source — the revision journal (#12)

> **Core invariant: the heatmap honestly shows “activity that passed through Notarium”, NOT the file history.** The journal stamps a revision with the time of the write/detection (`createdAt = now()` on append, `revisionJournal.ts`), not with the file's historical mtime. This is a documented boundary of the journal (#12) and exactly GitHub's “contribution graph” model: a freshly mounted or just-imported workspace is honestly EMPTY in terms of activity until people start editing it; an import produces a spike on the import day. The rest of the dashboard (stats/graph/orphans/health) is, meanwhile, always populated — from the read-model, it does not need the journal.

**Heatmap** (`ActivityHeatmap`): a GitHub-style grid of week-columns over a **rolling year** (53 weeks up to today; the contract leaves `from`/`to` open — “the whole period”/an arbitrary range will come for free). A day's intensity = the number of events, scaled 0–4 relative to the most active day of the window (`levelOf` — any day with activity ≥ 1). The timezone is the client's `tz` (minutes east, like the feed histogram): a day is counted by the user's clock, not the server's. A click on a day → drill: the feed shows the events of exactly that day.

**What we count as activity** (approved in #33): all edits — `created` (the note's first appearance in our system = a row the writer stamped `entry_role = 'origin'`), `edited` (subsequent write/external edits/restore), `deleted` (a tombstone), plus `unavailable` — a **journal gap** (#327). Per-space, **class-scoped** (#78: agent-memory is not counted — default `user`). Three deliberate caveats in the count:

- **The synthetic baseline is excluded.** The first edit of a pre-existing note first mints an `external` baseline (a pre-edit snapshot), then a `write`. Both are on the same day → they would double the “first edit”. The cut-off predicate is `entry_role <> 'baseline'` — the WRITER decided which of the three roles the row plays and stored it ([note-history](note-history.md#model)); it also cuts off the first-sighting of an external file, a single honest compromise. Nothing infers it on read any more: `kind = 'external' AND base_rev IS NULL` stopped meaning “first entry” once a quarantine could leave a note with no trusted parent at all (#327).
- **A gap counts, and it counts as nothing else.** When a cross-space id collision contaminated a note's chain, the affected rows are served as gaps ([identity](core.md#identity)): the event is real, and what it was cannot be read without a payload the row withholds. It gets its own `unavailable` bucket rather than being guessed into `created`/`edited`/`deleted`, and `total` is the sum of all four. The baseline suppression above never drops it either — not because a gap has no parent, but because the predicate is written `QUARANTINED OR entry_role <> 'baseline'`: quarantine does not touch the role, so a contaminated row that IS a baseline still emits as a gap. A gap carries no principal, so it belongs to nobody: `author=mine` excludes it, and `hasOtherAuthors` compares only the attributed buckets — a gap alone never claims "someone else was here". In the feed it renders as `IconClock` + the verb `Unavailable`, with a neutral title, no churn and no author; in the heatmap it joins the day's intensity, the tooltip and the accessible label as `N unavailable`, and the cell carries `data-unavailable`.
- **The journal does not write moves** and they are not in the feed. The journal's dedup by `(hash, title, slug, tags)` eats a pure move (the folder is not in the key) — a “moved” event simply does not exist. The #33 spec mentioned moves; this is structurally impossible without a filePath history from the identity registry — deliberately omitted.

**The “what changed” feed** (`ActivityFeed`) is a **GitLab-style timeline** (no backdrop, full width): a vertical rail, the type icon sits on it (a circle with the page background masks the line = a “node”). As of #217 the row is **two-line** (“expands down and wide”, the space was freed up by the tiles in #216):

- **Line 1 — location + title + time.** The note's path as a **breadcrumb** (`Folder › Subfolder › Title`): each folder segment is a real link into its Files view (`folderRoute`, #212/#214), the title is a link to the note (a deleted one opens in its trash state), the time is on the right at the same level. The folder breadcrumb collapses (ellipsis) before the title — the note's name stays readable when narrow.
- **Line 2 — metadata.** `<verb> · <±churn> · <author>`. The author is shown **only if it is NOT you** (a shared space), privacy-filtered (#13, the same `withAuthors` as in note history) — in a personal space the row is clean, without “you · you · you”.

**The path is resolved on the server** (#217): a journal revision does not carry a filePath, so the route joins the event's `noteId` with the note's CURRENT folder from the read-model (`store.list()`) — the same join that “Projects” does. This is the note's location NOW, not at the moment of the edit (the journal does not store a path history, a pure move is not journaled — “where it lives” is the only honest answer, and it matches the note's own breadcrumb). `path` on the wire: `''` = the space root (no breadcrumb, only the title), `null` = the note is not in the live index (deleted / moved away) — also without a breadcrumb.

Newest on top. The same feed does the day drill (the `Changes on <date>` heading + a reset). Heatmap + feed together are the **Activity surface** (the default tab).

The feed is grouped before its result limit. `Group: Note | Folder | None` is a
browser-local preference; `Note` is the default. A Note row is keyed by stable
note id and summarizes the qualifying event count, known churn, and newest event.
Folder mode folds those note summaries by the note's current visible containing
folder and discloses `folder → note → raw events`; root and unavailable current
locations are separate typed buckets. Ordinary folder rows are visibly qualified
as `Folder · <path>` so a valid folder named `Workspace root` or `No current folder`
cannot collide with either structural bucket. Location reads the same in every
mode: a Note row shows its current folder (only when it has one) as the same
breadcrumb the raw event row draws, every segment a link into that folder's Files
view, and a Folder row keeps the `Folder · ` qualifier as plain text ahead of the
same linked segments; the structural buckets stay labels, because there is nowhere
to navigate. Every row dims everything but its own subject: on a Note row the
breadcrumb is context and the title carries the voice, and on a Folder row the
qualifier and the parent segments are context while the folder's own segment is
the subject. Clicking a segment never toggles the disclosure or opens the note.
`None` is the compatible flat event feed.
Disclosures are lazy, bounded cursor pages, several rows may stay open, and their
buttons name the concrete note/folder through `aria-expanded`.

Every grouped page carries three independent cuts: the commit-ordered source
ordinal (`through`), an opaque Activity model lease (`activityVersion`), and the
current-location generation (`locationThrough`). PostgreSQL revision ids remain
event identities, but do not order cross-note commits. Cursors bind all three
cuts. Every token is non-empty. A nullable `through` is the unique empty-ready
snapshot: zero rows/total, no cursor and no other-author gate. An append advances
`through` without changing the model lease; a semantic
journal rewrite changes the lease and clears every Activity slice; a move changes
only the location cut. Cumulative group counters and churn are decimal strings on
the wire so they never pass through an inexact JavaScript number. Group failure is
never rendered as empty or silently changed to `None`: cold failures show an
inline retry without an empty-state claim, while generic warm failures retain
the last internally consistent slice with a notice. A typed rebuilding response
clears the invalidated slice, but it is a state, not a failure: it never reaches
the error channel, draws no alert and offers no retry (a retry would only re-enter
the same lease). The first five seconds of a rebuild episode are a bare skeleton;
past that threshold the feed adds one `role=status` line above the skeleton, in
the standing lane and in an open day alike (the day's own gate is closed
meanwhile). It yields to a failure that owns the lane: when the standing notice
is showing an ordinary error with a working retry, the calm "it will refresh on
its own" would promise a `changed` frame no network failure sends. That notice is
standing-only, so inside an open day the rebuild line stays — there it is the only
explanation the skeleton has. The threshold belongs to the episode and lives in the layout-owned
feed hook, so coalesced reloads and pill switches never re-arm it, and nothing
polls: the projection's own `changed` frame on publication reloads the feed and
ends the state. A real failure — network, 500 — stays a visible error with a
working retry. Ordinary appends never blank a published slice. The skeleton marks
only "no data for this slice yet" — cold start, a Space, Group or scope change, a
day change, a rebuild, a retry window — never a refresh in flight: rows, counters
and times update in place, and open branches and an open day survive. Branches are
reconciled in one pre-paint pass over the open keys the new parent has a row for:
a settled branch (not loading, no error, no continuation cursor) whose group row
did not change is re-stamped to the new source cut without a request; every other
open branch is refreshed with exactly one request and keeps its previous items
while the reload runs. A folder is additionally not re-keyed while an open nested
note of its own is still marked loading: a nested branch has no producer other
than its folder's reload, so re-keying past one would strand it. `loading` is only
a claim about a request, and a cut advance discards the requests it finds in
flight, so the pass refreshes a branch whose claim has no live request behind it
even at an unchanged cut, and a nested branch stranded by a folder reload that
then failed inherits that failure with a retry. `Loading…` is drawn only while a
request that can deliver is in flight — the branch's own, or, for a nested note,
whatever its folder has in flight, because a folder reload's re-seed is what
delivers its nested rows. Membership of the in-flight set is literal: a request is
added when issued and dropped when it settles, so a finished reload never stands
in for one that is still coming. A nested row therefore waits out a folder page
request that will not re-seed it, which costs one round trip and never a wrong
row; and a response that lost a race to a later request for the same key is
discarded rather than stamped onto the branch at its own older cut.
Everywhere else a stale claim — a nested note under a folder the pass kept, a
collapsed key it never visits — reads as a failure with a retry that reloads
against the page still rendered under it, never as a spinner nobody will replace. A continuation cursor is bound to its cut and never
survives a cut change. The day drill splits its identity the same way: the model
lease, the location cut and a gate-recovery epoch are hard and clear the day, the
source cut alone is soft and refetches without clearing. Generic detail failures belong only to that branch;
a typed rebuilding or stale location/model response, or a successful lease
mismatch, invalidates the branch
and reloads the owning standing/day snapshot instead of retrying the same cut. A typed
stale/rebuilding signal in a day overview or one of its details also promotes to the
standing gate: a day lane cannot leave a globally invalid Mine scope published.
Added and removed churn axes remain independently nullable: the UI renders only
known axes and never substitutes zero for an unknown value.

**The “mine / everyone” toggle (#218).** On the right of the **reference row** (`notes · tags · links`) is a segmented control (`core/Segmented`) `Everyone` / `Mine`: a lens for “whose activity I am looking at”, as in GitLab's contribution graph. It lives in the row (not a separate line), and its scope is the **entire Activity surface**: the heatmap + the standing feed + the day drill all follow a single choice (a click on a “my” day will not show other people's edits). The filter is **server-side** (`author=mine`), not client-side: the per-day intensity is accurate over the whole window, not only over the loaded feed page. “Mine” = revisions whose `principal` is mine (the UI session `user:<me>`, my agent `pat:<me>:*` / `oauth:<me>:*`, any key-id — this way old revisions of a deleted PAT are not dropped, plus the legacy `ui`); exactly the `describeAuthor.mine` predicate, only expressed as a principal filter in SQL (`AuthorFilter = {exact, prefixes}`, the `authorClause*` drivers) rather than per-row resolution. **Gating is by all-time standing Activity, not the 53-week heatmap window or member count.** The unscoped standing response of the active Group mode returns `scopeGate {hasOtherAuthors,through,activityVersion}`: another principal and trusted external `principal=null` turn it on; a quarantined gap belongs to nobody and does not. Note/Folder get the gate from `/activity/groups`; None gets it from its own standing `/activity/events`, never from the heatmap or a hidden Note request. An early Mine result is publishable only when its cut and lease equal the gate; otherwise the client refetches Mine on the gate pair. If the gate is false the effective scope is Everyone and the toggle hides, but the preferred Mine value remains stored and becomes effective again in a shared Space. The segment reflects the **click**, not the last resolved gate: it renders the preferred scope, which is honest exactly while the control exists, because every resolve publishes `canScope ? preferred : 'all'`. Data still waits for the gate — the feed slice is keyed on the preferred scope, so a click resets it: the previous scope's rows can never render under the new label (nor be retained by a warm failure on the flip), the day gate closes, and the toggle itself stays put through the reset because an unresolved gate keeps the previous chrome. The reference row's height is reserved (`min-height`), so the toggle appears/disappears without a jump; on a narrow container the toggle is icon-only (`@container`) to stay on one line (responsive). The “Activity N this week” tile (`tree.stats.week`, read-model) and the reference row are **not** scoped by the toggle — they are space-wide. Group and scope are exact localStorage contracts: `bm-dashboard-activity-group` = `note|folder|none`, `bm-dashboard-activity-scope` = `all|mine`; safe parsing defaults to Note/Everyone and blocked storage cannot break the surface. Both preferences survive reload, dashboard subroutes, and Space switches.

**The skeleton is not stale (#218).** The heatmap draws only the current view's data (`scoped.activity`, with no fallback from Mine to Everyone): during a space switch or the first Mine load it is `null` → skeleton, never someone else's numbers. Preferred Everyone may keep its already resolved unscoped heatmap while the grouped model rebuilds; no feed/day payload is published until the standing gate is ready. The key point: `useDashboardData` does not remount on a space switch (the same route), so it **tags the loaded bundle with the space** and derives `loaded.space === space ? data : blank`. A same-space refetch preserves SWR. The details of the skeleton pattern are in `ActivityHeatmap.tsx`.
The URL's Dashboard Space is authoritative immediately: while SpaceProvider trails the
new route by one effect, DashboardLayout passes the intended slug to all Activity lanes
and blanks provider-owned tree/project data. Feed, Mine and day caches therefore cross
the same A→B boundary as the original bundle instead of rendering one old-Space frame.
Once a same-Space Mine gate has resolved, switching Note/Folder/None retains that
exact warm Mine heatmap while only the new grouped feed gate resolves; first Mine,
Space changes and genuinely invalidated scope still use the honest skeleton. Typed
stale/rebuilding state remains sticky across further Group changes and failed retries
until a valid gate and aligned effective standing response clear it. An explicit Everyone choice selects the resolved
unscoped heatmap rather than reusing a committed Mine snapshot.

### Server-side aggregates

The heatmap and feed are computed **on the server** (we do not drag a year of rows to the client). Activity endpoints require `space:read` and degrade to an honest 404 `revisions_unavailable` on a host without a journal (a bare engine) — Activity then hides the heatmap/feed (the reference numbers remain):

- `GET /api/s/:space/activity?from&to&tz&author` → `{ days: [{date, created, edited, deleted, unavailable, total}], from, to }`. Aggregated by local day. SQL: `date(created_at, '±N minutes')` (sqlite) / `to_char(... + make_interval(mins=>tz) ...)` (pg), `GROUP BY` day, `SUM(CASE …)` over `entry_role`/`kind`. The `(space, created_at)` index already exists — a range scan over the window, no migration needed. `author=mine` (#218) adds `AND (principal IN (…) OR principal LIKE 'pat:<me>:%' …)` — counters only over my revisions (the predicate is built by the server from `req.principal.username` via `minePrincipalFilter`, a mirror of `describeAuthor.mine`; absent = the whole space).
- `GET /api/s/:space/activity/groups?by=note|folder&from&to&author&limit&cursor&through&activityVersion&locationThrough&location&path` → a discriminated grouped page. Every response has the nullable source cut, Activity lease and location cut; unbounded unscoped page one also has `scopeGate`. A current unbounded read folds cumulative actor/class heads. A bounded day read may aggregate the raw journal, but still requires a ready model lease. `location=folder|root|unavailable` asks for the Note page nested under one Folder group.
- `GET /api/s/:space/activity/events` has three explicit modes. Bounded `from/to/offset/limit/author` is the compatible raw API and stays available during rebuild. Standing None omits bounds/note id, requires a ready projection, returns `through + activityVersion`, and owns `scopeGate` when unscoped; a scoped refetch may supply that pair without a note id. Grouped detail supplies `noteId + through + activityVersion + locationThrough` and keyset cursor. `path` (#217) comes from the current projection: `''` root, `null` unavailable or a gap.
- `GET /api/s/:space/activity/projects?from&to&limit` → `{ projects: [{id, slug, displayName, path, count, lastAt}] }`. A **3-way join**: per-note counters from the journal (`activityByNote`, GROUP BY note_id) × the note's CURRENT folder (read-model) × the project registry (#13). A note is counted in the **deepest** containing project (disjoint buckets: a note in a sub-project does not inflate the root). The default window is ~90 days. **Without `limit` the server returns the whole ranking** — the Projects surface shows the full list; the “K active” counter metric on the tile = the length of the ranking.

Layers: the contract (`packages/contract`) → the journal truth plus its rebuildable meta-DB Activity projection → `RevisionPersistence` → `RevisionJournal` (background rebuild/GC owner) → the class-scoped `HistorySurface` → `CachedStore.activityProjection` (current metadata and location generation) → routes → web. File-backed SQLite executes projection maintenance and unbounded standing reads on its narrow Activity worker connection; route authorization, the current-location join and response shaping stay on the main process. The author filter rides as opaque `author` and `viewerAuthor` predicates: `author` filters returned rows before grouping, while `viewerAuthor` classifies the unscoped standing scan without filtering it. **A journal write is fire-and-forget**, so tests seed *history* through a synchronous fixture channel before the page opens, not through live POSTs; a *live mutation with the page open* is a real write through the API — a body edit when the point is that published rows survive it, a move when the point is that a location change clears them — never a create, which moves the location generation and legitimately clears every branch, giving a symptom indistinguishable from the defect. A test waits on the grouped response that follows the write rather than on the write itself.

An upgraded or semantically invalidated Space returns retryable `503
activity_projection_rebuilding` for every grouped Note/Folder read and every
standing gate. It never serves a partial generation or falls back to raw/None.
Projects, Health, notes and the bounded raw events API remain usable. Preferred
Everyone may retain the unscoped heatmap while the feed rebuilds; preferred Mine
keeps an honest skeleton until the standing gate is ready. Publication emits one
graph-neutral `changed` frame and does not wait for old-generation GC; that frame
is also what ends the client's rebuild state.

## Knowledge Overview — read-model (#60) → surfaces

The “what the base actually contains” data is now distributed across the tile-surfaces and the reference row (full lists, not truncations to 6):

- **Reference numbers** (the row below the tiles): **notes** (`/tree` `stats.total`) · **tags** (`/tags` `total`, #109) · **links** (`/graph` `links.length`, clickable into the graph). “New this week” moved to the Activity tile's metric; “projects” moved to the Projects tile's metric.
- **Projects** (the `/dashboard/projects` surface, `ProjectsSurface`): all projects (#13) by activity within the window — “where the work is happening / continue here”. The server join `/activity/projects` (see above), a **full list** with no ≥2 gate and no truncation. A row = the project name + the time of the last activity + a counter; it leads into the project's folder. Empty (a single-project space / no activity) → an honest empty-hint.
- **Hygiene** (the `/dashboard/health` surface, `HealthSurface`) — the connectivity repair queue, three read-only sections, each hidden when empty; a healthy graph → “Everything's linked up”:
  - **Broken links** — ghost targets (an unresolved `[[Label]]`) + who links to them; `graph/health` returns them as a repair queue: `refCount` = the number of unique visible source notes, sorted `refCount desc → title/target/id`; a click leads to the first source. **Full list** — the `ghosts` on the wire (`graphHealthToWire`) are NOT truncated (the truncation to 6 has been removed).
  - **Resolved via a former name** — links that the #100 alias model keeps working through former names (`note-alias` / `folder-alias`): renaming the target does not break incoming `[[Old]]`. A row = source → target + a type badge; a click opens the source (the raw `[[Old]]` is there). **The edges list on the wire is truncated** to `HEALTH_EDGE_CAP` (former-name ones are sorted first), so the badge shows the honest `staleNamed`, not the length of what is shown, and on overflow a `+N more` is drawn — as in the old `GraphHealthCards`.
  - **Orphans** — real graph nodes with degree 0. **Structural shift #216:** orphans moved here from the former Hubs/Orphans navigation block — an orphan is not navigation but a connectivity problem (“what is detached”), and its place is in the repair queue. They are computed on the client from `/api/graph` (the nodes carry `degree`), a full list.
  - **Why `graph/health` is a separate channel and not `/api/graph`:** the “via a former name” metric = the `resolvedVia` tag on an edge, which is set on a **fresh** derivation; the incremental `/api/graph` cache does NOT carry it. `graph/health` derives from a fresh `engine.graph()` once per snapshot revision and memoizes that revision (concurrent callers join the same derivation); it never substitutes the incremental graph. **Capability honesty:** a host without `graphHealth` answers 404 → the Broken/Resolved sections are empty, but Orphans are still computed from the graph.
- **Hubs — removed from the dashboard (#216).** Hubs (the top nodes by degree) duplicated the graph, which shows them richer: node size = degree, the “Hubs (min in-degree)” filter, clusters labeled by their hub (`GraphView`). The connectivity navigation point is the graph itself (the icon in the rail).
- **Favorites — removed from the dashboard (#216).** Favorites (#42) are available from the rail; they are not duplicated as a separate block on the dashboard.

## Layout

Top to bottom, everything full width (max-width 1080, container query by inline-size): the heading → the **tile bar** (`grid` 3 columns, one when narrow; the active tile is accent) → the **reference row** (`notes · tags · links`) → the **surface** (`<Outlet/>`).

- **Activity**: the `Everyone`/`Mine` toggle (#218) lives in the **reference row** above the surface (see above) → the heatmap in an **outline tile** (a frame without a fill) + the “What changed” timeline (no backdrop). While the data loads, the heatmap and the feed draw a **skeleton** (the same geometry, muted + a group shimmer; a heading shimmer; the feed — node rows, marked `data-skeleton` like the heatmap's cells), settle = a color change in place, without a shift; a refresh of already published rows never brings the skeleton back. The heatmap is **stable at any width, zoom, and DPI** (#219): all cells and all gaps use one shared size `--cell` / `--gap`, **snapped to a whole number of DEVICE pixels** by the `useDeviceSnappedGrid` hook (`ActivityHeatmap.tsx`): it takes `window.devicePixelRatio` (in Chrome it includes both the OS display scale of 125/150% and the browser zoom), computes integer `cellDevice`/`gapDevice`, and returns them back as CSS-px (`deviceInt / dpr`), recomputing on resize (`ResizeObserver`) and on a ratio change (a resolution `matchMedia`). The week columns and the month header columns use the same `--cell` track (`repeat(var(--weeks), var(--cell))`), the cells use `height: var(--cell)` instead of the former per-cell `aspect-ratio: 1`, and the vertical and horizontal gap is the shared `var(--gap)`. **Why JS and not pure CSS:** previously `minmax(0,1fr)` + a per-cell `aspect-ratio` gave the columns slightly different sub-pixel sizes, and under a **fractional** devicePixelRatio (OS scaling / zoom) the edges of each column were rounded to the device grid independently → the cells diverged by a pixel (that very “skew”). CSS works in CSS-px and does not see the effective scale; `round()` to `1px` only helps at an integer DPR. Device-snap places the cells AND the gaps on the device grid at any ratio (all cells are strictly the same size, the column step is uniform). The fallback before/without JS is a fluid `--cell` from `cqw` (`container-type: inline-size` on `.heat-inner`; `--cell = (100cqw − $dows − $gap·(weeks−1)) / weeks`): the rows are still even, just not device-snapped. `.heat-grid` is `flex: 0 0 auto` (it hugs the columns, it does not stretch across the whole track): integer cells do not tile an arbitrary width exactly, and since one shared `cellD` is rounded down (floor) over a fixed number of `weeks` columns, the per-column shortfall accumulates — up to `(weeks−1)` device-px = `(weeks−1)/dpr` css-px (up to ~`weeks` css-px, ≈50px, at dpr 1; half that at dpr 2) remain on the right — the grid leaves this shortfall **outside** its box, so that the loading shimmer (`::after inset:0`) glows strictly over the real cells and not past the last column (a deliberate trade-off for device evenness: an exact fill-width requires a fractional cell, and that is exactly the source of the drift). The month names have padding; the outline tile does not clip the outline of the rightmost highlighted cell (`overflow: visible`). The heatmap levels are a **dynamic scale, normalized to the most active day of the window** (`ceil(total/maxTotal*4)`, 5 steps; the top step is “whiter” for distinguishability); see `levelOf`. A cell hover is **its own floating tooltip** (delegated). The “What changed” timeline = GitLab-style: a vertical rail, a node icon, a **two-line row** (the location breadcrumb + title + time on top, `verb · churn · author` at the bottom — see Activity above); an empty day — `Nothing changed this day` in a reserved centered area.
- **Projects** / **Hygiene**: full-width **outline-tile** sections (one for projects; up to three for hygiene), lists of rows. The row separators are straight and full-width (an absolute line, not a border on a rounded row); on hover the neighboring separators are transparent so as not to stick out past the rounding. The section icons are neutral (without a per-card accent).

The theme is the palette's CSS variables (`--accent` for the heatmap levels and the active tile via `color-mix`), a live light/dark swap.
