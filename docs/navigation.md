# Rail navigation & the merged Files section (#42, #245)

Canonical notes for the left **rail** (VS Code's Activity Bar, #103) and how its
scopes light up. Read this before touching the rail, the explorer tree scope, or
the Favorites↔Files highlight — the invariant used to live only in `Sidebar.tsx`
comments, which is exactly what #245 said to fix.

Key files:
- `packages/web/src/composers/Sidebar/Sidebar.tsx` — the rail strip + the wide
  panel (space switcher + the Files or Agents explorer). Owns the picker, tree
  reveal, DnD, and the rail highlight.
- `packages/web/src/libs/tree/tree/explorerScope.ts` — `ExplorerScope` (the tree
  LENS) + `railScopeActive` (the pure, matrix-tested highlight helper, the ONE
  place the Files↔Favorites invariant is expressed). Unit test:
  `explorerScope.test.ts`.
- `packages/web/src/composers/NotesProvider/NotesProvider.tsx` — `nav.type`
  (`all | feed | folder`), the reader/scope surface signal.
- `packages/web/src/composers/AgentsExplorerProvider/AgentsExplorerProvider.tsx` —
  the Agents dataset state, per-owner/Space persistence, caches and invalidation.

---

## The rail (Activity Bar)

Top → bottom: **Home** (the brain logo) · **Files** · **★ Favorites** · Agents ·
Graph · Search · Trash (#245). The standalone **New (+)** button was
removed from the rail — creating a note now lives in the panel head (Collapse ·
Refresh · New, when the rail is open), the tree's right-click "New…" menu, and the
`note.new` hotkey. The merged **Files** section leads — it's where content lives —
and **Favorites** (its lens) follows. **Search**
is demoted near the end on purpose: the rail icon is a REDUNDANT Spotlight trigger
(⌘P and the topbar OmniSearch already reach it), so it doesn't earn top billing.
Each is a real `<Link>` (except Search = Spotlight and Favorites = a client lens
toggle) so a middle/ctrl-click opens it in a new tab (#29 Journey #4). The strip is
ALWAYS visible; the collapse toggle hides only the wide panel (the tree).

- **Home** = the space dashboard (`/s/<space>`, `nav.type==='all'`, #33/#216). Its
  logo owns home; no file-scope icon lights there.
- **Graph / Agents / Trash / Settings / Management** = *chrome surfaces*: the
  reader isn't showing a document, so no file-scope icon lights (`browsing` is
  false). `activeId` is retained only to restore the tree on return.

## Agents shell and Explorer

Agents owns one shell and one `PageFrame` across **Abilities → Context → Activity**.
Abilities keeps its routed **Roles | Skills** local rail. The wide Explorer panel has
an independent picker for **Roles | Skills | Memory | Sessions**; these are separate
read-models, not Files filters, and choosing one never changes the central route.
Files/Projects/Favorites remain in the Files picker and never include agent data.

An explicit top-pill or Roles/Skills-rail action reveals the route's natural Agents
dataset. A manual Explorer choice then survives entity navigation, Back/Forward and
reload until another explicit section action. The record is stored under
`notarium:agents-explorer:<owner>:<space-id>`; changing owner or Space restores that
pair's own picker preference.

Roles/Skills are listed for the **active Space**: Personal (the cross-space fallback,
always present), that Space, its Projects, then System and Catalog — in that order,
closest to the user first. The request carries the exact `spaceId`, and the server
applies it BEFORE the global location cap, so the Space the user is in is listed whole
instead of competing with every readable Space for one bounded scan. Placements
elsewhere are reached through the global library, which stays unscoped; the explorer
links to it rather than pouring other Spaces into the tree. Sessions remain the one
owner-global dataset.

Groups are ordinary collapsible tree rows — the same rows the Memory dataset uses,
with a chevron, a scope icon (Personal / Space / Project / System / Catalog) and the
plain display name. A Space and a Project may legitimately share a display name; the
icon is what distinguishes them, so the caption carries no address. Collapse state is
per owner + Space under `notarium:agents-explorer:groups:<owner>:<space-id>`, with
Catalog collapsed by default. The panel head offers the section's own `+` (New role on
Roles, New skill on Skills), the same affordance Files has.

Ability list, read, new, and edit are routed surfaces inside that one shell. Owned routes carry
the encoded durable locator; System/Catalog routes carry their immutable package id. A new Role or
Skill carries a random draft id in the URL and restores its owner-bound body from session storage;
its first successful publish replaces the draft history entry with the exact Owned route. Opening
Context from an Owned Role carries that same encoded locator in `?role=`—the selector and every
role-preset mutation keep exact identity even when several placements share a name. Project and
Space targets first adopt and remember the owning Space, because the Agents URL is space-free and
must not resolve a project slug through whichever Space happened to be active before the click.

Agents breadcrumbs expose the whole route hierarchy rather than only the current section:
`Agents / Abilities / Roles|Skills / <title>`, `Agents / Context / <scope> / <role>`, and
`Agents / Activity / <episode>`. An agent-memory note remains a Context surface:
`Agents / Context / Memory / <title>`. Its `/m/<id>/<slug>?context=<scope>` URL preserves the
originating Personal/project selection through read, Edit, Save, Cancel, reload and canonical slug
replacement; the same Agents rail therefore stays mounted for the complete editing journey.

At viewport widths up to 720px the wide panel is an ephemeral modal drawer, closed by
default. It does not change the persisted desktop collapse preference. Open moves
focus into the panel and makes the main surface inert; Tab stays trapped, and
Escape/backdrop/navigation close it and return focus to the opener.

## The merged Files section (#245)

Before #245 the **Feed** was a separate rail icon and `nav.type==='feed'` doubled
as a "not-explorer" signal. #245 merged Feed into **Files**: the feed, a folder
page, and an open note are **three faces of ONE section**, so a SINGLE "Files" icon
lights across all of them.

- The **Files** rail icon opens the section's DEFAULT view — the **feed overview**
  (`filesHref → /s/<space>/feed`). The last-read note is not the target anymore; it
  stays revealed/lit in the tree.
- The feed keeps its URL (`/s/<space>/feed`) and its own aside facet
  (`DocumentLayout.feedActive`); `nav.type==='feed'` still marks the feed sub-view
  — it's just no longer read as "not explorer".
- `railScopeActive` derives the highlight from an EXPLICIT surface signal:
  `onFilesSection = browsing && !memoryNoteOpen && (nav.type==='feed' || 'folder')`.
  A memory note (`/m`, the Agents surface) is NOT the Files section.

## The Favorites lens invariant (#42, kept through #245)

Favorites is a **tree LENS** (`ExplorerScope.kind==='favorites'`), persisted per
space in localStorage — not a route. It is **mutually exclusive** with Files on the
rail: exactly one of the two lights, and only on the Files section.

- **On-section: non-navigating.** Clicking ★ while you're already on a section face
  (reading a note / on the feed) filters the tree to favorited notes/folders/projects
  and lights the star WITHOUT changing the surface (fork B — you keep reading your
  note, the tree just narrows). Opening a favorite note keeps you in Favorites.
- **Off-section: land on the section first.** Picking ANY file-tree lens (Files,
  Projects, a single project, Favorites) from off-section — the Agents/Memory
  surface, the home dashboard, or a chrome page — navigates to the section's default
  view (the feed) so the chosen lens's icon lights where you land
  (`Sidebar.pickScope` — the user-pick path; `chooseScope` is the SILENT variant the
  automatic effects use, which never navigates). This is why Files and Favorites behave IDENTICALLY: before
  #245 picking a lens from Agents dropped you on the DASHBOARD, where the star lit but
  Files couldn't — an inconsistency. Now both land on the section and light the same
  way. (Memory is the exception — it's a route, so picking it navigates to Agents.)
- **Mutual exclusion + section-only.** `railScopeActive` returns `favoritesActive`
  (the star) OR `filesActive` (the Files icon), never both, and NEITHER on the home
  dashboard / chrome / a memory note:
  ```
  onSection       = isFilesSection({browsing, memoryNoteOpen, navType})
                  = browsing && !memoryNoteOpen && (navType==='feed' || 'folder')
  favoritesActive = onSection && scopeKind==='favorites'
  filesActive     = onSection && (scopeKind==='files' || scopeKind==='projects' || scopeKind==='project')
  ```
  The home logo owns home, so no file-tree icon lights on the dashboard — for Files
  AND Favorites alike (the #245 consistency fix; pre-#245 the star lit on the
  dashboard, Files didn't).
- **Two exits, no flicker.**
  1. *Sync* — clicking **Files** drops the lens back to the general files tree
     (`leaveFavoritesOnNav`, plain-click only) as it navigates to the feed, so the
     icon lights and the tree switches in one frame.
  2. *Effect* — navigating to a **chrome surface** (Graph/Agents/Trash/Settings)
     clears a sticky favorites lens as a post-navigation effect, so a note opened
     LATER reads as Files, not a re-lit star. On the new surface the star is
     already un-lit by the `browsing` gate, so the scope resets silently.
  The **feed no longer triggers this reset** (#245) — it's part of the section now,
  not a way out of it. Only true chrome surfaces reset the lens.

**History:** the flicker/double-light bugs behind this invariant are catalogued in
#42 (the rail-highlight bug). #245 rewired it off
`nav.type==='feed'` onto the explicit `onFilesSection` signal without changing the
model.

## Tests

- `explorerScope.test.ts` — `railScopeActive` as a full state MATRIX (surface ×
  lens × memory × chrome): never both lit, the mutual-exclusion + memory/chrome
  gates.
- `test/e2e/files-feed-favorites.spec.ts` — the invariant end-to-end: lens filters
  the tree without navigating, star↔Files exclusion, open-favorite-stays-favorites,
  Files sync-exit, chrome resets the lens.
- `test/e2e/rail-last-file.spec.ts` / `nav-new-tab.spec.ts` — the single Files icon
  tracks the section and opens the feed overview; no Feed icon.

## Seeds

`make seed CASE=favorites` seeds a browsable space (feed + tree) with starred notes
across folders, a starred folder and a starred project — the stand to check this
invariant by hand. Favorites are real-applier-only in the catalog; e2e/visual seed
them through the live API. See `docs/seeds.md`.
