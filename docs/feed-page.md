# Feed page (#32) — spec, gotchas & test checklist

Canonical notes for the Feed page. Read this before touching the feed, its
cards, the snippet pipeline, or before writing tests for it. It captures the
behaviour AND the subtleties we stumbled on, so they don't get re-derived.

Key files (post-#19 monorepo layout):
- `packages/web/src/composers/FeedView/FeedView.tsx` — the page (`FeedView`, was `FeedPage.tsx`),
  `FeedTimeline`/`FeedCard` and the layout cascade
- `packages/web/src/composers/FeedProvider/` — `useFeedState` (lifted feed state, was `useFeed`)
- `packages/web/src/widgets/FeedAside/` — the aside facets (folder tree + mini-stats)
- `packages/web/src/services/previews/previews.ts` — client preview layer: session map + viewport batches
- `packages/web/src/core/Skeleton/`, `packages/web/src/core/Icons/` — primitives
- `packages/core/src/services/snippet/` — `makeSnippet`/`firstImage`/`countWords` (pure, server-side;
  split out of the old `server/index.js` in #19)
- `packages/web/src/styles.css` — still the global stylesheet (SCSS-module split is a later #19 pass)

---

## What it is

A personal documents feed. Two views, a size toggle, optional grouping, sort,
and a folder facet (in the aside). Header controls order: **Group · Sort · Size · View**.

Since #245 the Feed is the **default view of the merged "Files" section** — it has
no own rail icon: the single Files icon opens `/s/<space>/feed`, and feed / folder
page / note are three faces of one section (see `docs/navigation.md` for the rail
model + the Favorites lens invariant). The feed's URL, aside facet and data flow
below are unchanged.

The **folder facet** (#93/#109) is an INCLUSION set (the app's one filter language,
shared with the tag pane), not a single-folder scope: the shared `FolderTree` in filter
mode (a neutral checkbox mark, `swatch={false}` — no colour axis here), where a row click
ADDS that folder's whole subtree to the focus and the right-click menu offers **Show only
this folder** (select just it) · Include/Exclude · Clear. The selected swatch is filled, an
unselected one is a hollow border; nothing selected = no filter = everything shown. The
set is in-memory (not persisted — a transient exploration, and folder paths go stale on
rename, exactly like the graph's filter). It rides the wire as `folders` (see Data flow)
— the same subtree-cascade inclusion algebra the graph uses, in one shared place
(`libs/tree/selectedFolders`: `dirSelected`/`folderShown`/`toggleFolder`). Multiple
selected folders OR/union; "show only" is a one-element set. There is no header chip — the
active filter reads off the aside (filled swatches + Clear), the way every filter does.
Deliberate refinement: pure inclusion can't express "hide one nested folder, keep its
siblings" (an exclusion concept) — "Show only this" covers the focus case; a separate
exclude would be added only if that workflow returns.

- **List view** → a **timeline** (`FeedTimeline` / `FeedTimelineRow`): a two-column
  row split by a continuous vertical **spine**. Left **gutter**: the row's date
  (+ thumbnail) right-aligned against the spine. Right: title + tags + snippet.
  The image lives in the gutter, so the **title always starts at the same x whether
  or not a note has an image** — that was the whole reason for this layout (no
  placeholder needed for missing images). Each row is marked by short **top rules**
  over the date and title that latch the spine (date rule + title rule meet at the
  rail = one line across the row); hover lifts title + date grey→white, snippet a
  touch. Date-group headers sit centred **on the spine**, breaking the timeline.
  See the dedicated timeline section under "Gotchas". `5` (Small) drops the thumb
  for a compact text-only timeline.
- **Grid view** → tiles (`FeedCard`), with a **Size** toggle = column count:
  - `1` (Large): single column, big cards, image as a top banner (≤420px tall).
  - `3` (Medium, default): **structured dense grid** — image tiles span 2 rows,
    text tiles span 1, `dense` packs two text tiles beside one image tile; banner
    is a shorter 16/7.
  - `5` (Small): **uniform square "poster" tiles** — image is the card
    background (cover, slightly desaturated), title in a single page-bg block, date
    chip; no snippet/tags.
- **Mobile** (content width `< 560`, see "Responsive cascade"): both views collapse
  to ONE forced layout — single-column `FeedCard`s — and the Size/View toggles hide.

The **Size** toggle also sets snippet length everywhere via `--lines`:
`{1:12, 3:6, 5:2}` lines. Line-clamp never pads — a short note shows fewer lines.

## Data flow

- Since #64 the Feed owns its own **server-windowed** data: `GET /api/s/<space>/notes?sort=&offset=&limit=&folder=&depth=&folders=&tags=&q=&from=&to=&tz=&dateField=` (space-scoped since #16) computes filter+sort+slice from the read-model snapshot and returns the honest `total`; the client holds a sparse page cache (50/page, LRU 16 pages) — the full list never crosses the wire. The Feed's folder facet (#93/#109) sends `folders` (one repeated query key per selected subtree → an array server-side; INCLUSION, OR/union, subtree-cascading prefix-match, applied after `folder`); "show only" is just a one-element set. The bucket histogram takes the same filter axes so its `total` stays in lockstep with the window's. Each note carries `modifiedAt` and `createdAt` — ISO instants since #54 (`modifiedAt` is journal-precise for everything that happened on the server's watch and midnight-UTC where only the engine's day signal exists; `createdAt` is the registry's first-seen value, so it no longer drifts on edits; null = the engine honestly doesn't know, and `sort=created` excludes undated notes from the window AND its total). Freshness rides the shared SSE stream: a `changed` event touching a VISIBLE note — one shown under the selected-folder filter (`folderShown`; the `upserts`/`removed` ids are the filter) — refetches the held pages, coalesced at 1s. Folder facets + mini-stats come from `GET /api/s/<space>/tree` via NotesProvider.
- **Previews** (`{ snippet, image, tags, words }`) travel two ways since the #64 rework — never one request per card:
  - **Warm inline**: the Feed's window requests pass `?preview=1`, so each note arrives with its warm cached preview (or `null` when cold) — the server answers from the read-model's preview cache with a synchronous peek (`previewPeek`), never an engine read. `useFeedState` primes the client session map (`primePreviews`) before the notes render, so warm cards never even ask.
  - **Cold batches**: `POST /api/previews { ids }` (≤100/req) — ONE request per viewport-ish burst, collected by `services/previews`. Wanting is refcounted: virtualization unmounting a card releases its claim, a queued id nobody wants is dropped before it's sent, and an in-flight batch whose every id lost its claimants is **aborted** (`AbortController`; the server detects the drop via the response stream's `close` + `!writableEnded` and stops deriving mid-batch). Viewport claims queue ahead of bulk ones (graph facets). Fast-scrolling ten screens costs the viewport you stop at.
  - Server side, a cold derivation prefers the **readBody capability** (P5): when the space's notes are on local disk (the in-process engine over `NOTES_DIR`) the raw file is read and derived in ~ms (`derivePreviewFromFile`: frontmatter tags + title-heading strip = byte-parity with the engine path); without it (a remote engine) the serialized read serves, ~180ms each. Measured live: 100 cold previews ≈ 60ms via files vs ~18s via a remote round-trip.
  - The client session map is a dedupe + prime target, NOT a freshness mechanism: SSE `changed` ids drop entries precisely (`dropPreviews`), LRU-capped at 2000.
- `GET /api/s/<space>/notes/buckets?sort=&group=day|week|month&folder=&depth=&tags=&q=&from=&to=&tz=&dateField=` → the **date histogram** of a notes query: consecutive `(key, count)` runs in list order (key = bucket start as a local YYYY-MM-DD; `''` = the trailing undated bucket), counts summing to the same `total` the matching `/api/notes` reports. `tz` is the client's UTC offset in minutes east, so day boundaries match the user's clock. This is what grouped layouts are built FROM — headers, section sizes and the honest scrollbar are known before a single item loads.
- **Tag axis (#109/#204).** Tags are a server-side navigation axis, not just card chips. `GET /api/s/<space>/tags` is the **tag facet**: every tag with note counts (`{tag, label, count, direct}`, flat-sorted-by-path → the client nests `a/b`), computed from the read-model snapshot under the same class-visibility checkpoint as `/tree`. The shaper is shared — `core/libs/tags` `buildTagFacet` — so the server endpoint and the graph (which builds the same shape client-side off `GraphRealNode.tags`) agree by construction. `/api/notes` (and `/notes/buckets`) take a repeated `tags=` query key (an **OR/union set**, hierarchical + case-insensitive via `foldTag`/`matchesTags` — `?tags=ml` also lists `ml/nlp`; multiple keys widen the result), so the window/`total`/histogram all describe the tag-filtered population — no client-side preview sweep. The selected tags are **URL state** (a repeatable `?tag=`): `useFeedState` reads `getAll('tag')` (drives the window + histogram + `queryKey`); `toggleTag`/`clearTags` edit the set. **UI — one shared pane, one filter language.** The `TagFilter` widget (used identically in `FeedAside` and the Graph filters) is **hierarchical chips + search + top-N**: inclusion (nothing selected = no filter, a click ADDS a tag — accented), a parent's `▾` reveals its children as an indented sub-row, search jumps to any tag. The active filter reads off the aside chips — **no chip floats over the Feed content** (it used to and clashed with how every other filter surface reads). Read-surface tags (Feed cards, reader header, Meta panel) render through `core/Chips` `TagChip`/`TagChips`: neutral by default, color-ready via `--tag-color`, preserving the authored label while href/data-tag use the folded key. Reader and Meta chips link to `/s/<space>/feed?tag=<folded>`; Feed-card chips are not links because the whole card is already the note link. The graph adds a tri-state (All/Tagged/Untagged) above the same filter chips; specific-tag selection is OR + hierarchical over `GraphRealNode.tags`.
- **Text axis (#190).** A full-text query `q` is the third filter axis, alongside folders and tags — the app's one filter language (folder ∧ tag ∧ q). `/api/notes` and `/notes/buckets` take an optional `q`: the server resolves it to the set of note-ids the engine's **lexical** search matches (`store.search(q, { lexicalOnly: true })` — containment, not vector similarity, because a "filter" admitting a neighbour that shares no term reads wrong), intersects the snapshot with that set, then slices/sorts/windows/counts exactly as without `q`. So the window, the honest `total` and the histogram all describe the q-narrowed population (lockstep), and **ordering stays by `sort` (date)** — `q` narrows, it doesn't rank (a relevance sort is an additive future option). Membership is bounded (`FEED_Q_CAP`) — generous for a personal base. Degrades honestly: a backend without FTS narrows by whatever its `search` returns (the e2e fake = title+body substring). The query is **URL state** (`?q=`), read by `useFeedState` (in `queryKey`, so a change reloads the window like any filter flip); the topbar **OmniSearch** field sets it (in place on the Feed, by navigation elsewhere — see `docs/spotlight.md`). Quick-jump suggestions are a SEPARATE surface (ranked hybrid `/search`), not this filter.
- **Date range axis (#201).** `from`/`to` are optional inclusive local calendar days (`YYYY-MM-DD`) in the URL. `/api/notes` and `/notes/buckets` receive them with `tz` (minutes east of UTC), convert note instants to the user's local day, and filter BEFORE slice/window and bucket counts. UI v1 filters by the current `sort` axis: `Created` → `createdAt`, `Modified` → `modifiedAt`; because that axis changes the meaning of `from/to`, `sort` is URL-aware (with the saved preference as fallback only for non-date URLs), and picking a date writes the active `sort` into the URL. The hidden `dateField=created|modified` query parameter is contract headroom for "created in June, sorted by modified" later. A note with no usable date on the selected axis is outside an active range. The aside owns the visible controls (two DatePickers + clear), not the header — it is a filter facet like folders and tags — and its title names the active axis (`Created date` / `Modified date`) so the range is not ambiguous. The pickers enforce a valid span: `From` cannot move after `To`, `To` cannot move before `From`, and calendar navigation is disabled once the adjacent month/year/page is wholly outside the allowed side of the range.
- `useFeedState` (`packages/web/src/composers/FeedProvider/useFeedState.ts`) is **lifted** state shared by the page and the
  aside (one data window). Owns: `sort`, `view`, `cols`, `group`, the hidden-folder
  set (`hidden` + `toggleFolder`/`soloFolder`/`resetFolders`, #93),
  the sparse window (`total`, `itemAt`, `ensureRange`), the URL filter axes
  (`tag`, `q`, `from`, `to`), the histogram (`buckets`, refetched with the pages on
  the coalesced SSE sweep), `folders`, `stats`.
  Persists prefs to localStorage (the hidden set is NOT persisted — graph parity).
- **Loading skeletons.** A card's title + date come from the already-loaded list,
  so they render immediately; only the snippet/tags/image are lazy. While
  `useSnippet` returns `null` (in-flight — it resolves even on error, so it never
  sticks), the card shows shimmer placeholders via the reusable
  `packages/web/src/core/Skeleton/` (`<Skeleton>` / `<SkeletonText>`, base `.skeleton`
  CSS). Snippet skeleton line count = `LINES[cols]`, so the reserved height ≈ the
  incoming text and the layout barely jumps. Per-view parity is kept in CSS: c5
  hides the snippet/tag skeletons and instead shimmers a cover (`.feed-thumb-skeleton`);
  banner thumbs (c1/c3/list) are **not** reserved (unknown image presence would
  jump more than it saves). The component is generic — reuse it for any async area.

localStorage keys (plain strings, **not JSON**): `bm-feed-sort`
(`created|modified`), `bm-feed-view` (`list|grid`), `bm-feed-cols` (`1|3|5`),
`bm-feed-group` (`off|day|week|month`; migrates legacy `'1'`→`day`).

---

## Gotchas we hit (don't re-learn these)

1. **CSS specificity trap — hit twice.** The generic `.feed-card .feed-snippet`
   / `.feed-card .feed-row-title` rules sit *late* in `styles.css`. A size/view
   override at *equal* specificity (`.feed-grid-c5 .feed-snippet`) **loses** to
   them by source order. Fix: out-specify by including `.feed-card`
   (`.feed-grid-c5 .feed-card .feed-snippet`). **Any new per-size/per-view
   override must out-specify the later generic rules.** This was the single
   biggest recurring footgun.

2. **`-webkit-line-clamp` vs float-wrap are mutually exclusive.** line-clamp needs
   `display:-webkit-box`; float-wrap needs normal flow and must NOT create a BFC
   (so no `overflow:hidden` on the wrapping text). The old "news" list floated the
   image and fought this with a `:has()` mode switch + `max-height` clamp (which can
   *slice* the last line). **The timeline sidesteps it entirely** — the image lives
   in the gutter, never in the text flow, so the snippet is a plain
   `-webkit-line-clamp` box with no float. (Kept here because the grid card snippet
   still uses line-clamp, and any future inline-image text would hit this again.)

3. **`grid` + `overflow:hidden` + fixed tile height slices text.** A title/snippet
   wrapping to one more line than the tile height allows gets cut mid-line
   ("gets cut off horizontally"). Fix: clamp the text by line count AND size the
   track for the worst case (e.g. c5 title clamps at 3 lines, track sized for 3).

4. **Markdown tables in snippets.** At 220 chars they were invisible; once
   snippets grew (600→1600) raw tables dumped `| Metric | Q1 | --- |…`. `makeSnippet`
   now strips table rows, HR, list markers, wiki-links, md links, code, html,
   footnotes, and truncates **at a word boundary** with "…".

5. **Images are external** (`picsum.photos` in seed data). `firstImage()` returns
   **only absolute http(s) URLs** — local attachment paths are skipped (they'd
   404 through the current proxy; our own API will serve them later). `<img onError>`
   self-hides so a dead URL never leaves a broken-image box.

6. **(Resolved in #64, reworked in the follow-up) per-card preview requests are GONE.** The server's read-model owns the preview cache (read-through LRU with real invalidation); warm previews ride the notes window inline (`?preview=1`), cold ones go through abortable viewport batches (`POST /api/previews`) — see "Data flow". `services/previews` keeps a session dedupe map whose entries are dropped the moment an SSE `changed` event names their note (covers our own writes and external/multi-user edits alike). If previews ever linger, the bug is in the server cache's invalidation, not here. Server-gone-cold latency is a config question: mount `NOTES_DIR` (readBody capability) and cold derivation is a file read.

7. **(Historical) the old `server/index.js` carried a stray NUL byte** that made
   `grep`/`rg` treat it as binary and return nothing silently. That monolith was
   split into TS packages in #19; the snippet pure-fns now live in
   `packages/core/src/services/snippet/` (clean, greppable). Kept as a reminder:
   if a search comes back suspiciously empty, try `rg -a` or the Read tool.

8. **Dev infra:** app runs in docker via `npm run dev` (vite for web + `tsx watch`
   for the server). If a server change isn't picked up in the dev container,
   restart the container. Client (JSX/CSS) hot-reloads via HMR.
   (The old "clear the sessionStorage snippet cache" note is obsolete — there is
   no client persistence anymore.)

9. **`dense` grid reorders visually.** In c3, `grid-auto-flow: row dense` pulls a
   later tile up to fill an earlier gap, so strict chronological order is **not**
   preserved in the multi-column grid. Accepted trade-off for the structured
   packing. Also: a tile only becomes `span 2` once its image is known (after the
   async snippet fetch), so tiles **re-pack on load** — mostly masked by the
   200px IntersectionObserver preload margin.

10. **Grid heights are hand-tuned and fragile.** c3 `grid-auto-rows` is a fraction
    of column width via **`cqw`** (container query units — relies on
    `.feed-page { container-type: inline-size }`). The factors (e.g. c3 `0.74`)
    were re-tuned whenever content changed (e.g. when the date moved into the
    chip row). Any content change to a tile likely needs a re-tune + visual check.

11. **c5 title backing is ONE block, not per-line — on purpose.** It started as
    `box-decoration-break: clone` on an inner `.feed-row-title-ink` span so the
    background hugged each line's width (ragged). That can't satisfy "more
    top/bottom padding than inter-line gap": with clone, the per-line vertical
    padding `P` is the ONLY knob, and the geometry forces inter-line gap ≥ `P`
    while block top/bottom = `P` — so inter-line is always ≥ top/bottom, and
    shrinking `line-height` to tighten lines makes the lower line's background
    paint over the upper line's text. The fix was to drop the ink span and put a
    single `background`+`padding`+`border-radius` on `.feed-row-title` itself with
    `width: fit-content; max-width: 100%` (hugs the longest wrapped line, never the
    full column). Now block padding (top/bottom breathing) and `line-height`
    (inter-line) are **independent**. Trade-off accepted: short lines get backing
    out to the longest line's width (rectangular block, not ragged per line). The
    block bg tracks the card on hover (`var(--bg)` → `var(--bg-hover)`). **If you
    ever want ragged-per-line back, you give up independent top/bottom padding —
    it's a hard CSS constraint, not a tuning miss.**

12. **Timeline (List view) — the fiddly bits.** `FeedTimeline`/`FeedTimelineRow`,
    a `[gutter | content]` grid per row.
    - **Spine = `border-left` on `.feed-tl-main`, NOT one absolute line.** A per-row
      border runs continuously *within* a group but breaks cleanly at each group
      header (incl. the first) — so the rail never dangles beside a header. (An
      absolute `::before` line was tried first and looked wrong at the first group.)
    - **Per-row mark = short top rules over the date AND title only**, via
      `box-shadow: inset 0 1px 0` (NOT `border-top`: a real 1px border grows the box
      and nudges the title out of line with the date — the first, borderless row
      gave it away). Scoped to `.feed-tl-row + .feed-tl-row` so the first row / first
      row after a header has none. The rules **latch the spine** (date `margin-right`
      / title `margin-left` of `-16px` reach the rail) so date-rule + title-rule read
      as one line crossing the spine; a small outer `padding` makes them overshoot
      the text. Space *under* the rule comes from a 6px `padding-top` on date/title/
      tags, with the columns' `padding-top` cut 6px to match — so the text stays put
      and **rows don't grow apart**.
    - **Group label centred ON the spine:** a label box `width: calc(var(--tl-gutter)
      * 2)` from x=0 has its centre land exactly on the rail (gutter is fixed width).
      No background; symmetric margins; it "breaks" the timeline. Per-row dates still
      show, EXCEPT under **day** grouping (`showDate={group !== 'day'}`) where the
      header already is the day.
    - Week headers show the **ISO week number** (`isoWeek`), not a localised date.
    - **Seed caveat:** sort=Created is all one day → one group; sort=**Modified** has
      spread mtimes → multiple groups (only then do the group-break / week numbers
      show). The old `FeedNews` "news row" + its float/`:has` CSS were **deleted**
      when the timeline landed.

---

## Current layout constants (so you don't hunt)

- `FeedView.tsx`: `LINES = {1:12,3:6,5:2}`, `ROW_ESTIMATE = {1:280,3:170,5:78}` (virtual timeline first guesses), `GRID_BLOCK = {1:12,3:30,5:40}` + `BLOCK_ESTIMATE` (virtual grid blocks), `SECTION_HEADER_ESTIMATE = 44` (grouped grid); `useFeedState.ts`: `PAGE_SIZE = 50` (server window), `MAX_PAGES = 16` (held-pages LRU). The grow-window (`PAGE = 24` + sentinel) is GONE — every regime virtualizes.
- **Responsive cascade** (JS, off the measured content/header width, `useElementWidth`):
  `< 680` → **compact**: controls fold into an "Options" dropdown (threshold tracks
  the ~568px controls row — re-measure if you add/remove a control). `< 560` →
  **mobile**: additionally hide the Size + View toggles and force ONE layout —
  `.feed-grid-mobile` single-column cards, 6-line snippets, a moderate 16/9 banner
  (NOT the c1 hero). Stored `view`/`cols` are left untouched, so desktop restores
  them. (Width-based, so a desktop with both side panels open also simplifies.)
- `previews.ts`: `BATCH_MAX = 32` ids/request, `MAX_INFLIGHT_BATCHES = 2`, `COALESCE_MS = 16`, session map `MEM_CAP = 2000`, IO `rootMargin: '200px'` (no persistence — see gotcha 6). Wire cap: `PreviewsRequest` ≤ 100 ids.
- `packages/core/src/services/snippet/`: `makeSnippet(..., max = 1600)`.
- `styles.css` (grid): c3 `grid-auto-rows: calc(100cqw/3 * 0.74)`, image tile
  `grid-row: span 2`, banner 16/7; c5 `aspect-ratio: 1/1`, image as absolute cover
  bg (`grayscale(0.3)`/`opacity .9`, hover `grayscale(0.5)`/`opacity 1`), title is a
  single `fit-content` block on `.feed-row-title` (`var(--bg)` bg, `var(--text)`,
  `padding 7px 10px`, `line-height 1.25`; hover → `var(--bg-hover)`) — see gotcha 11;
  c1 banner `height: 420px`.
- `styles.css` (timeline): `--tl-gutter: 160px`; columns `padding-top: 8px` + date/
  title/tags `padding-top: 6px` (rule-to-text gap, see gotcha 12); gutter `gap: 13px`
  (thumb-at-snippet-level); thumb `max-width 140px`, hidden in c5; rule colour
  `var(--border)`.
- Chips: `.feed-tag` is only the Feed's contextual marker class on shared neutral
  `TagChip` read chips; `.feed-date` is a neutral grey date pill. Grid order =
  date first then tags (bottom-left). In the timeline the date is a plain grey
  label in the gutter (no chip bg). **Folder/path removed in both views.**

## Virtualization (#64, sized for 10k+)

Every regime virtualizes; grouped layouts are laid out from the server's bucket histogram (`/api/notes/buckets` — see "Data flow"), so section boundaries are known before any item loads and sparse windows can land anywhere without moving a header.

- **List (timeline)** — TRUE virtualization (`@tanstack/react-virtual`, `FeedVirtualTimeline`): row count = the server's `total` (the scrollbar honestly spans the whole base), only viewport+overscan rows mount and scrolled-past rows unmount, a jump to an arbitrary offset asks the data layer for exactly that window (`ensureRange`), unfetched rows render as ghost shimmer rows. Group headers come from the histogram (`useSectionStarts`: window index → label at each section start) — a header renders even when neighbouring rows haven't loaded; the old "withhold until both neighbours are known" dance is gone. The per-row top rule is the explicit `.with-rule` class (the old `.feed-tl-row + .feed-tl-row` sibling selector can't see across absolutely-positioned rows).
- **Grid, group=off** — BLOCK virtualization (`FeedVirtualGrid`): true per-tile windowing fights c3's `dense` packing (a tile's row-span flips when its image loads and dense flow re-packs everything after it), so items chunk into fixed blocks (`GRID_BLOCK`: c1 12 / c3 30 / c5 40), each block is its own `.feed-grid` (dense packs WITHIN a block only) and blocks virtualize like big rows (estimated, then measured). Accepted trade-off: packing can't pull a tile across a block boundary, so c3 may show an occasional gap at a block's tail edge.
- **Grid, grouped** — the SAME block scheme per section (`FeedVirtualGroupedGrid`): the histogram turns each bucket into ⌈count/GRID_BLOCK⌉ blocks (the section's first block carries the `h2` header; partial tail blocks estimate proportionally), and the one flat block list virtualizes exactly like group=off. While the histogram hasn't answered (or failed), the view degrades to the ungrouped grid rather than blocking. The grow-window is gone.

Bucket labels are derived from the bucket KEY (the section's authoritative start), not from item dates — the histogram is the single source of section truth, so a midnight/DST edge can't put a header and its items out of sync.

---

## Test checklist

**Pure functions (`packages/core` snippet service + `packages/web` libs — easy unit tests):**
- `makeSnippet`: fixtures with frontmatter, fenced code, **tables**, HR, ATX
  headings, ordered/unordered lists, images, **wiki-links** (`[[a|b]]`→`b`,
  `[[a]]`→`a`), md links→text, html tags/comments, footnotes. Assert: no raw
  markdown syntax leaks; whitespace collapsed; **truncates at a word boundary**
  with "…"; respects the 1600 cap; short input returns as-is (no "…").
- `firstImage`: markdown image, bare `<img src>`, frontmatter ignored;
  **http(s)-only** (relative/attachment paths → `null`); none → `null`.
- `toDate`: ISO and date-only both parse to a **local** date (no UTC day drift in
  grouping); invalid → null. Day/week/month bucket labels (Today/Yesterday/…).

**Component (jsdom + mocked `api.notesGet`/`api.previewsPost`):**
- IntersectionObserver must be **mocked/polyfilled** (jsdom has none). It drives
  `useInView` (per-card preview gate).
- Only **in-view** cards claim previews; warm inline previews never trigger a
  batch; releasing every claim of a queued id unsends it, of an in-flight batch
  aborts it (see `services/previews`).
- Size/view/group/sort persist to the right localStorage keys (plain strings);
  legacy `bm-feed-group='1'` migrates to `day`.
- Created sort hides notes with no `createdAt`; Modified shows all.
- Cards/rows are real `<a href>`; a modified click (ctrl/middle) is **not**
  preventDefault'd (new-tab nav), plain click navigates in-app.
- Folder facet (#93/#109): a row click ADDS that subtree to the filter (server
  `folders`, INCLUSION, OR/union, prefix-cascade); "Show only" selects just it; Clear
  resets. The histogram total tracks the filtered window. Algebra unit-tested in
  `libs/tree/selectedFolders.test.ts`; the server vertical (incl. repeated-key→array
  parse) in `test/fake-server/conformance.test.ts`.
- List view (desktop) renders `FeedTimeline`, grid (or mobile) renders `FeedCard`;
  the `mobile` branch forces single-column regardless of stored view/cols.
- `isoWeek`: ISO-8601 week number (Mon-based; year boundaries — e.g. 2026-01-01).
- `showDate` is false only under day grouping; group label centres on the spine.

**Layout (NOT testable in jsdom — use Playwright/e2e against the public URL):**
- jsdom can't compute `:has()`, container queries, `cqw`, `aspect-ratio`,
  `-webkit-line-clamp`, `box-shadow`. Verify visually/e2e:
  - Timeline (List): title starts at the same x with/without an image; date + title
    top rules latch the spine and align (same y); spine breaks at group headers; the
    group label centres on the spine; c5 drops thumbs; rows don't grow apart when the
    rule's `padding-top` is added (text stays put). Measure these with `getBoundingClientRect`.
  - Grid c3: image tiles span 2 rows, two text tiles pack beside; titles not sliced.
  - Grid c5: uniform square tiles; one-block title hugs text (not full column);
    snippet/tags hidden; title bg tracks card on hover.
  - The specificity overrides actually win (assert computed `-webkit-line-clamp`/
    `display` on c5 snippet).
- **CI note:** if a server change isn't picked up in the dev container, restart it
  (see gotcha 8). Visual/e2e baselines run via `npm run visual` / `npm run e2e:docker`.

## Known open polish (intentionally deferred)

- Text-only c5 poster tiles (no image) are mostly empty below the title block.
- c5 square (`1/1`) could become `5/4` if more image area is wanted.
- `dense` reordering vs chronology (see gotcha 9) — drop `dense` if strict order
  is ever required (reintroduces gaps).
- Timeline rule/spine colour is `var(--border)` (subtle); bump to `--border-strong`
  if a louder grid is wanted. Lazy thumbs still pop-in in the gutter (no reserved
  slot, by design — no placeholder for missing images).
