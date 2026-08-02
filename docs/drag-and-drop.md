# Drag-and-drop & the file tree — behavior spec, backend quirks, test checklist

This captures the non-obvious rules behind the sidebar file tree and its drag-and-drop
move feature, plus the engine behavior that shapes them (§8 — the notarium engine;
#69/#97). Use it as the spec when writing tests and when
refactoring — most of these cases are easy to break without noticing.

Key files (paths are post-#19 monorepo layout):
- `packages/web/src/composers/Sidebar/Sidebar.tsx` — the tree, `FolderItem`, `NoteRow`, drag/drop
  handlers, reveal, context-menu wiring (`treeApi`) + inline `RenameInput`
- `packages/web/src/core/ContextMenu/` — the right-click popover (positioning + dismiss)
- `packages/web/src/core/Modal/` + `packages/web/src/core/Dialog/` — the modal primitive and the
  app-wide `useDialog().confirm()` system that replaced native `confirm()` for deletes
- `packages/web/src/libs/dnd/dnd/dnd.ts` — drag payload + `canDropInto` rules
- `packages/web/src/libs/tree/tree/tree.ts` — `buildTree` (flat note list → nested folder/file tree)
- `packages/web/src/composers/useNoteActions/` (+ `NotesProvider`/`EditingProvider`) — `moveItem`,
  `renameItem`, `removeNote`, `removeFolder`, `duplicateNote`, `openNote`, routing/reveal wiring
  (these used to live in the old `App.jsx`)
- `packages/server` (transport: `/api/move`, `/api/note`, `/api/s/<slug>/move-folder`,
  `/api/s/<slug>/folders`) + `packages/engine` (the notarium engine: `localFs`
  directory channel, `move`/`makeDir`/`removeDir`, move-failure detection)

---

## 1. Layout (2-pane)

- Two columns: the rail (search + scopes + file tree) and the reader. There is **no**
  middle note-list column (removed — the tree is the file browser now).
- The "new note" action lives in the **FILES** section header (`.section-head` `+`).
- Search results and the **Recent** list render **in the rail** (they used to live in
  the removed column): `query` present → results; `nav.type === 'recent'` → recent list;
  otherwise the tree. `Graph` → graph view.
- The **logo** is home: it clears the reader and goes to `/` (the logo is a `<Link>` to `/`).
  There is no separate "All notes" scope item — the logo covers it. The rail also
  resizes/collapses (see the [editor-aside-architecture] note) and has a pinned
  **Settings** footer (`ProfileMenuButton`) that reuses `ContextMenu` for the theme
  switch.

## 2. The tree shows folders **and** files (Obsidian-style)

- `buildTree` already builds note leaves; the tree renders them via `NoteRow`.
- **`NoteRow` (and the Recent/Graph scopes + the home logo) render as real `<a href>`** (the
  SPA route, `noteRoute(id)` → `/n/<note-id>`, #51 — a trailing readable segment is
  tolerated by the router but not generated; reserved for future SEO urls), not
  `<button>`. A plain left click `preventDefault`s and navigates in-app.
- **Modifier-click is multi-select IN THE TREE (#163, a deliberate change of the old "modified-click opens a new tab" rule).** A Ctrl/Cmd-click toggles a row in the selection set, Shift-click ranges from the anchor — both `preventDefault` so the anchor neither navigates nor opens a tab (see §4). The **new-tab affordance survives** on a tree note via **middle-click** (a non-primary button, untouched) and the context menu's "Open in new tab". OUTSIDE the tree — search results, Recent — `NoteRow` is rendered with `selectable={false}`, so it stays a plain link and a modified click falls through to the browser as before (`isModifiedClick(e)` in `libs/routing/routePaths` still governs those). **DnD still lives on these anchors** — `draggable` + `onDragStart` set the custom payload (the anchor's own link-drag is overridden). Folders stay `<button>` (they only toggle, no route).
- **Root-level files** appear at the top level of the tree (after the folders) — this is the only way to see notes that live at the project root (they have no folder to nest under).
- **Lazy + virtualized (#64, sized for 10k+ notes).** The tree boots from `GET /api/s/<space>/tree` (folder skeleton + counts; all space-scoped surfaces ride the `/api/s/<space>/…` prefix since #16); a folder's notes load on expand (`…/notes?folder=&depth=direct&sort=title`, shimmer skeleton rows while in flight — an un-arrived listing must not read as an empty folder). The visible structure is flattened to rows (folders / notes / skeletons, nesting = `depth` indent) and windowed by a virtualizer over the rail's scroll pane (`VirtualTree` in Sidebar.tsx): only rows near the viewport are mounted, scrolled-past rows unmount. The open note's row is nudged into view on change (`scrollToIndex`, align auto).

## 3. Folder click = expand/collapse only

- A **plain** click on a folder **toggles** it (like Obsidian/VS Code) and does NOT highlight it — this is what removed the old "folder + file both highlighted" confusion, and it still holds for the common gesture. A plain click also CLEARS any multi-selection (it re-anchors there; §4).
- A **modifier** click on a folder selects it instead of expanding (Ctrl/Cmd toggles it in the set, Shift ranges) — matching VS Code, where ctrl-clicking a folder selects without opening it. So a folder gets a highlight ONLY inside an explicit multi-selection.
- The reader/single-open is driven by the open note (file), not by folders.

## 4. Selection — open note + the multi-select set (#163)

- The **open note** (`activeId`) is the always-on single highlight, gated on a doc surface (below). Since #229 it is **visually distinct from a selection** — but the difference is **purely neutral grey depth, no accent** (#103's language holds): `.active` keeps the light `--bg-hover` pill it always had, while `.selected` paints a **denser** `--border-strong` grey ("this is in the set"). A row that is BOTH open and selected shows the deeper set-grey PLUS a neutral **left border** (a `::before` bar) marking it as the open one within the set — so all three states (open / selected / both) are distinct, still with no accent. *(Before #229 both painted the same `--bg-hover` and were indistinguishable, which made the open file's set-toggle invisible and the set unreadable when a member was open; #163/#206 → #229. Both fills use `background-color`, not the `background` shorthand — the shorthand reset `background-clip` and erased the 1px inter-row gap, which is why selection looked cramped.)*
- **The open note PARTICIPATES in the set (#229).** `activeId` and the selection Map are independent state, but the open row is a normal selectable row: a ctrl/cmd-click on it toggles it in/out of the set with a **now-visible** effect (its light pill deepens to the denser set-grey and gains the left border), and once in, a drag or delete carries it with the rest. The set stays the **EXPLICIT** pick — a plain click opens the note and CLEARS the set (the open note does NOT auto-join); to move/delete the open file together with others, ctrl-click it in. This is the "select a pack, one of them is open" flow the pre-#229 conflation broke (VS Code-parity).
- **Multi-select set (#163).** Ctrl/Cmd-click toggles a row, Shift-click ranges from the last clicked row (the anchor) over the flattened tree — notes AND folders, mixed. Every member gets `.selected` (the neutral grey fill). A folder gets a selection highlight ONLY here (an explicit multi-select) — never on a plain click (§3). The set is the payload of a multi-item drag (§6).
  - It is held in `Sidebar` as a `Map<dragKey, DragItem>` — keyed by `'note:<id>'` / `'folder:<path>'` and carrying the drag payload **captured at click time**, so a row that scrolls out of the virtualized window stays selected (we never read it back from the DOM). Each selectable row is a `role="treeitem"` under the tree container's `role="tree" aria-multiselectable`, so `aria-selected` is both a real assistive-tech status AND the stable, hash-proof test signal (tests assert on it).
  - Shift-range resolves through the pure `rangeSelect(rows, anchorKey, index)` (`libs/dnd`): the inclusive run of selectable rows between the anchor and the click, in either direction, skipping skeletons. If the anchor row is gone (its folder was collapsed), it returns null and the click degrades to a **single**-select — never an empty "click into nowhere".
  - Selection is **pointer-only** in #163 (Ctrl/Cmd/Shift-click). No keyboard path into the set (no Shift+Arrow / Ctrl+A) — only Escape out of it; keyboard multi-select is deferred.
  - A **reader** (no write access) never selects: a modifier-click on a tree note opens a new tab (the affordance a writer trades for select), a folder just toggles. Selecting would be a dead gesture — the rows aren't draggable.
  - It is **transient**: cleared by a plain click (navigate/toggle), a click on the empty area, Escape, a space switch, entering the search panel, and after a successful move (the rows relocated, so the captured srcFolders are stale). It is NOT persisted.
- The `Recent` / `Graph` scope chips still highlight to indicate the rail's current mode — that's a separate section from the tree, not a "second selection".
- **Chrome-only surfaces don't light the tree (#94).** Graph, Settings and workspace
  Management retain `activeId` (so "Files" can return to the last note) but the rail's
  highlight is gated on actually being on a doc surface (`onChromePage` in `Sidebar.tsx`).
  Without this, opening a note then going to Settings left the note's row highlighted.

## 5. Reveal (expand the tree to the active item)

- Driven by `browseFolder` (= `nav.folder` while browsing), set by: a move (`moveItem`
  sets `nav` to the note's new folder) and deep-links (`applyRoute`).
- When a note is open, reveal opens the note's **own folder** (so the file row is visible);
  when only a folder is targeted, it opens just the **ancestors**.
- **Reveal-on-sync (#161, VS Code "reveal active file").** The FILES **Refresh** button
  (`refresh-tree`) doesn't just reload data — after the `refreshFolders` await it re-reveals
  the *already-active* note: `revealAncestors(lastNote.filePath)` re-opens its chain and a
  bumped `revealNonce` re-arms the scroll. Both halves are needed because, for a note that's
  already active, neither auto-fires: the reveal effect keys on `browseFolder`/`noteOpen`
  (unchanged, so it won't re-run), and the scroll is **latched per reveal intent** (the token
  `activeId#revealNonce` in `ExplorerVirtualRows`) — a note that's already active doesn't
  change `activeId`, so bumping `revealNonce` is exactly what re-arms it. Without both, a
  manual *Collapse all* then *Refresh*, or a scroll away then *Refresh*, would leave the active
  note hidden/off-screen. The re-armed reveal is async-aware: it stays armed across reflow and
  fires once the row reappears in `rows` after the lazy listing loads (with a short rAF re-apply
  to survive a late virtualizer mount reset). Gated on a note actually open on a doc
  surface (`noteOpen` + `lastNote.id === activeId`), so chrome pages / agent-memory /
  mid-navigation never mis-target; an out-of-scope open note already bounced to Files (§8b
  Q3) — except a deliberately-focused project with a foreign note open, where any ancestor keys
  outside the focus simply don't render (inert), so the visible reveal stays scoped. (A standalone
  "reveal without refresh" was deliberately NOT added — sync is the single trigger.)
- **The reveal scroll clears the floating glass head (#161).** Every reveal (deep-link AND
  sync) aligns the row to `start`, i.e. `scrollPaddingStart` px below the rail-scroll's top
  edge — but the frosted `panel-head` floats OVER that top edge (absolute, `--panel-head-h`
  tall). So the inset is the **measured head height + one row** (`headH + EXPLORER_ROW_HEIGHT`),
  not a fixed guess: a short viewport makes the head taller than the old 58px and the note
  landed UNDER the glass. Header + one row keeps the note's immediate parent folder visible
  as context just below the head.
- **Reveal fires on INTENT, not on reflow (#242).** The scroll follows the active row into view
  ONLY when the open note changes (`activeId`) or a host re-arms it (`revealNonce`) — the one
  latch token above. Any OTHER reflow (a folder expanded/collapsed *above* the open note, a lazy
  listing landing, a DnD reorder) must NOT re-scroll. Before #242 the effect re-probed on every
  `activeIndex`/`totalSize` change, so expanding a folder above the open note yanked the scroll
  back down to it — asymmetric, since expanding *below* left `activeIndex` untouched and so
  didn't. The companion invariant is **scroll-anchoring**: on a reflow with no active reveal,
  `ExplorerVirtualRows` re-pins the top visible row (by key + sub-row offset — exact at the fixed
  `EXPLORER_ROW_HEIGHT`) so rows inserted/removed above the viewport never shove the visible
  content. Native `overflow-anchor` can't help — the rows above the window aren't in the DOM. So
  reveal navigates on a real intent; anchoring holds position on everything else (it's also what
  keeps a multi-wave reveal-on-sync from drifting as sibling listings land). Covered by
  `test/e2e/explorer-scroll-position.spec.ts`; manual QA via `make seed CASE=explorer-scroll`.
- Reveal itself only ever *adds* to the open set. Two companions keep that set honest as
  paths change — a folder's open state is keyed by its **path** (folders carry no id):
  - **Carry across rename/move** (`carryOpenKeys`, called from `commitRename` / `sectionDrop`):
    a folder rename or move re-keys the folder *and its expanded descendants* to the new path,
    keeping the old keys too — so nothing collapses during the server round-trip and a failed
    move leaves the prior expansion intact.
  - **Self-heal** (reconcile effect on `folderTree`): prunes open-set keys absent from the
    server-authoritative skeleton — the now-stale old keys after a rename/move, a deleted
    folder's key, a folder recreated at an old path. This **relies on the directory channel
    loading atomically** (§8, never partially): a partial skeleton would wrongly read a valid
    open folder as stale and collapse it.

## 6. Drag-and-drop move

Note moves go through `api.moveNote` → `POST /api/move` (id-addressed — the identity
registry decides the note's space, #16); folder moves through `api.moveFolder` →
`POST /api/s/<space>/move-folder` (space-scoped — a folder move can't cross a space
boundary; a MARKED folder DOES carry a portable identity in its `.notariummeta`, #13,
which travels with the move). Both reach the engine's `move` (folders with
`isDirectory: true`).

### Drop targets & hit area — one section-level surface (#64 flat rows → #94 fast-drop)
- The drag/drop **events are handled once, at the `.folders-section`** (not per row). Every row just *declares* its target folder in `data-drop-folder` (a note row → its parent, a folder row → itself, a skeleton → its folder; `''` = root). On dragover/drop the section reads the target from the row under the pointer (`dropFolderAt` = `e.target.closest('[data-drop-folder]')`), so **the deepest folder under the cursor wins** by DOM nesting — no propagation tricks, no per-row `stopPropagation`.
- **Why section-level, not per-row (#94 follow-up):** native HTML5 DnD only fires `drop` on an element whose *latest* `dragover` called `preventDefault`, and the browser throttles dragover. With per-row handlers a fast drag could release a frame after crossing into the target row, before that row's own dragover fired — the drop silently failed and you had to slow down and hover precisely. One continuous surface stays "accepting" under the pointer the whole time. The section **always `preventDefault`s** on dragover (so a fast release never slips through a gap); validity only governs the highlight and whether the drop does anything.
- **Root** drop zone is the same `.folders-section`, stretched to fill the rail (`flex: 1`): the empty area below the rows has no `data-drop-folder` ancestor → resolves to `''` → root (mapped to the ROOT sentinel so the section wash lights). Root-level file rows carry `''` too.

### Highlight while dragging
- Only the **target folder's own row** lights — `.drop-target` (neutral grey fill + a solid `--border-strong` outline, VS Code-style; no accent/primary, #103). Hovering a child (note or subfolder) resolves the target to its parent folder, so that **folder row** lights, not the hovered child. We deliberately do NOT wash the whole subtree per-row anymore: each row is a rounded pill, so stacked washes scalloped into a ragged column (#103) — and VS Code lights the folder, not its contents. Trade-off: if the target folder's row is scrolled out of view, the drop still works but shows no on-screen highlight. The section computes the highlight `mark` from the current target and **clears it when the target is invalid** (a same-folder no-op shows no highlight — never the root, §"don't fall through to root"). Dragged source is dimmed (`.dragging`).

### `canDropInto(item, destFolder)` — the validity rules (`packages/web/src/libs/dnd/dnd/dnd.ts`)
- **note**: invalid if it already lives in `destFolder` (same-folder no-op).
- **folder**: invalid if dropped on itself, on its current parent, or into one of its own
  descendants.

### The drag payload is a SET (#163 multi-select)
- The module-level slot holds `DragItem[]` (a plain single drag is just a one-element array — every reader is uniform, there is no separate "multi" kind). `startDrag(e, items)` takes one item or an array; `currentDragItems()` / `readDrag(e)` always return an array.
- A drag begins from a row via `beginDrag(item, e)`: if the grabbed row is in the selection set, the WHOLE set is dragged, else just that item (an unselected row drags alone, like VS Code). A multi-drag also sets a small "N items" `setDragImage` so the count shows under the cursor.
- `canDropInto` stays **per-item** (unchanged). Two set helpers sit on top: `droppableInto(items, dest)` is the subset that actually moves (every member passing `canDropInto`); `canDropAnyInto(items, dest)` is the highlight gate (true iff at least one moves). A mixed set lands its legal members and silently skips the no-ops / illegal ones — so selecting folders A+B and dropping into A's own child moves B and skips A; dropping a set whose every member already lives in the target is a no-op with no highlight (same "don't fall through to root" rule).

### The "don't fall through to root" rule (subtle, easy to regress)
- When the row under the pointer resolves to an **invalid** target, the section sets the highlight `mark` to `null` — **no** highlight, and crucially **not** the root. Concretely: dragging a file onto a **sibling file in the same folder** must show **no** highlight (it's a same-folder no-op), not a root highlight. (With the old per-row handlers this needed `stopPropagation`; the single section surface makes it just "compute the target, light it only if valid".)
- An invalid hover clears any existing highlight (incl. a stale root one); `dragleave` off the section and `dragend` clear whatever is left.

### After a successful move
- If the moved item is the open note (directly or under a moved folder), the reader just
  **reloads in place** (`reloadNote`) — since #51 the note's URL is its id, so a move never
  changes it; the reload refreshes the path metadata and points `nav` at the new folder
  (reveal). No re-resolution by title, no re-routing.

### Post-mutation refresh is **narrow** (#94, easy to regress back to broad)
- Every tree mutation (`moveItem`/`renameItem`/`removeNote`/`removeFolder`/`duplicateNote`,
  plus the editor save) refreshes **only the folders it touches** — `refreshFolders(paths)` in
  `NotesProvider` reloads the tree skeleton + just those listings the session holds. Do **not**
  go back to the old broad `refresh()` (reload every loaded folder): on a deep tree that's ~95
  requests in one wave, which saturates the browser's HTTP/1.1 connection pool so the **next**
  `/api/move` queues behind it (pending up to ~5s on a high-RTT link) and a re-drop conflicts.
  A move refreshes `[srcFolder, dest]`; a rename/delete/duplicate its single folder; the editor
  save its folder (+ the old one if an edit moved the note out of it).
- **A note move is optimistic** (`applyLocalMove`): the row relocates in the local caches
  *before* the round-trip (latency-independent), then the reconciling refresh confirms it. A
  folder move is **not** optimistic (it relocates a whole subtree — beyond a single-row edit) —
  it just takes the narrow refresh, single-flight-guarded.
- **A multi-item drop is N single moves through the existing paths (#163), not a batch endpoint.** `moveItems(items, dest)` in `useNoteActions` is THE move entry point (a single drag is just a one-element set). Notes each ride the optimistic per-note pipeline (`enqueueNoteMove`: independent + coalesced); folders go through `moveFoldersBatch` — sequential `api.moveFolder` (each single-flight-guarded) then ONE combined refresh of the union of touched parents + dest (a single folder's set is `[srcFolder, dest]`, identical to the pre-#163 path). A per-item failure toasts but does not abort the rest, so a partial success is visible. The whole-set move is **not** transactional (the issue's recommendation 1 was declined — per-item server moves already converge).
  - **Same-basename collision is engine-resolved, not pre-checked.** Dragging two folders that share a last segment (`x/docs` + `y/docs`) into one target both aim at `target/docs`; the second `moveFolder` hits a name conflict server-side and toasts, the first lands. The combined refresh then shows the real tree — no silently-lost row — but the user only sees one error. We do not pre-dedupe colliding destinations (rare, and the engine is the authority).
- **Per-note move pipeline** (`useNoteActions`, `drainNoteMoves`) — the correctness core for
  rapid chained re-throws (you grab a note again and move it while the first ~5s move is still
  pending). Guarantees:
  - **At most one `/api/move` in flight per note.** A drop while one is pending doesn't fire a
    parallel request — it updates the note's desired destination (`plan.destPath`); the running
    drain picks it up when the in-flight move returns. So same-note moves can never race or land
    out of order on the backend (`moveNote` is id-addressed to an absolute path — two concurrent
    ones could otherwise leave the server at the wrong folder).
  - **Strict order + last-drop-wins.** The drain loops, committing the latest desired
    destination each time another drop arrived while it was busy, and the *final* committed move
    is always to the last drop's folder. Because each move is sent only after the previous one's
    response arrived, the transport can't reorder them. Net: after any burst, the backend
    converges to the last-dropped folder (intermediate hops may be skipped — the file just goes
    straight there).
  - **No resurrection.** Each optimistic hop bumps `folderLoadSeq` of both folders, so a listing
    fetched before the move is discarded — a stale read can't re-add the note to a folder it left
    (the duplicate bug, now also across chained moves).
  - **Failure → server truth.** Once the chain settles (or a move fails — occupied dest / engine
    down → toast), it reconciles **every folder the chain touched** against the server, so the
    row snaps to where the backend actually left the note rather than a guessed rollback.
- **The duplicate-row fix is the load-seq bump in `applyLocalMove`.** A folder listing fetched
  *before* the move (a concurrent refresh or scroll-driven load) carries stale membership — the
  note still in its old folder — and, landing afterwards, would resurrect it in two places.
  Bumping each touched folder's `folderLoadSeq` makes `loadFolder` drop that superseded answer.
  Per-folder seq protects a single listing; this protects cross-folder consistency at a move.
- **Multi-client / external convergence (#94).** All of the above is local to the mover. Another
  client (or an agent) learns of the move through the `changed` SSE event — which carries the
  upserted notes' **current folders** (`StoreEvent.folders`, filled centrally in
  `CachedStore.emit`). The observer refreshes both the folder it had cached (old, via `dirOfId`)
  and the folders the event names (new), so the note relocates correctly without a reload.
  Without that field the event was id-only and an observer resolved the folder from its own stale
  cache → it refreshed the old folder, never the new one, and the note vanished from its tree
  until reload. The backend is always the single source of truth (moves apply serially server-
  side; last one wins), so every client converges to the same final folder.

## 6b. Right-click context menu & inline rename (issue #15)

The tree's default actions are also reachable by right-click, VS Code-style. The menu
is a dependency-free popover (the `ContextMenu` core component); the rows wire it via a shared
`treeApi` bag (mirrors the `dnd` bag) carrying menu + rename state and the action
callbacks. `useNoteActions` and the providers own the actions.

### Menu composition (deliberate, per #15 discussion; #97 added New folder)
- **Folder:** New note · **New folder** · Rename · (Mark/Unmark project) · Copy path · Delete.
  Since #97 folders are first-class — empty ones are durable on disk (never-prune,
  §8) and the directory channel surfaces them — so "New folder" (`api.createFolder`
  → `POST /api/s/<slug>/folders`) creates a real empty folder under this one.
  Create-in-folder ("New note") still seeds a new-note draft with that directory.
- **Note (file):** Rename · Duplicate · Copy wikilink · **Copy note id** · Delete. No
  "create" (a file has no children). "Copy wikilink" copies a `[[Title]]` wikilink;
  "Copy note id" (#232) copies the bare 12-char `notarium-id` — the rename-stable
  reference an agent drops straight into `get_note` (also on the note topbar's ⋮ menu,
  offered to readers too). "Duplicate" copies content into `<title> copy` in the same
  folder and opens it. Every copy action confirms with a toast (`useCopy`).
- **Root (empty tree area):** New note (directory `''`) · New folder (at root) ·
  (New project, when the principal can manage projects). The FILES header "+" menu
  carries the same trio.
- **Multi-selection (#206):** right-clicking a selected row targets the whole selected
  set; right-clicking an unselected row clears the old set and targets only that row.
  The multi menu is deliberately smaller: Copy paths (newline-separated paths for notes
  and folders) · Delete N items. Rename, Duplicate, Open in new tab, project mark/focus,
  New note and New folder stay single-target actions.

### Hit area & precedence (same model as DnD)
- `onContextMenu` lives **per row** (flat-row model, #64): a folder row opens the folder's menu, a note row opens the note's menu — the **deepest** target under the cursor wins by construction. Rows `stopPropagation`.
- Root's `onContextMenu` is on `.folders-section`; rows stop propagation, so it only fires on genuinely empty space (below the last row).
- The context menu resolves an **effective target set** before it opens (#206): selected
  row → current multi-selection; unselected row → one row. This keeps the visible
  selection and the action payload aligned, rather than letting a highlighted set
  silently survive while the menu mutates one unrelated row.

### Inline rename (`RenameInput`)
- Replaces the row's label with a focused, text-selected `<input>`. **Enter / blur
  commit; Escape cancels.** A `done` latch stops the Enter→blur sequence from
  committing twice. Commit is a no-op if the name is unchanged or empty.
- **Folder rename** = a directory move to a sibling path (`move_note` `is_directory`);
  the subtree relocates. The engine does **not** rewrite other notes' inbound links —
  there is no inbound-link rewrite anywhere (that long-standing claim was a myth, #100). A
  folder rename/move now records the OLD path in the folder's path-history (#100 phase 3,
  §8.6), so path-form `[[olddir/note]]` keeps resolving (through the folder-alias
  layer) and a bookmark to the old folder URL `/files/<oldpath>` canonically
  redirects to the current path. The open note (if under the folder) keeps its id —
  and therefore its URL — so the reader just reloads in place.
- **Note rename** = change the **title** (which drives the on-disk filename). Goes
  through the same in-place path as the editor (read content → save with
  `originalId` = the note-id), so the file is *moved*, not duplicated (see #8). The
  id — and the `/n/<id>` URL — survive untouched (#51); the reader just reloads.
  In the tree the SAME `data-id` row carries the new title. Inbound `[[Old Title]]`
  keep resolving: the rename records the old title in the note's alias-history (#100),
  so the resolver finds it id-first → current title → alias — no source bodies touched.

### Delete
- Confirmation goes through the app-wide dialog system (`useDialog().confirm()` →
  `lib/dialog.jsx`), not native `confirm()` — a styled, themeable, promise-based modal
  built on the `Modal` primitive. It resolves `false` on Cancel / Escape / backdrop and `true`
  only on the destructive action, so call sites read like the old `confirm()`.
- **Note:** confirm, then `delete_note`; clears the reader if it was the open note.
- **Folder:** one server call — `DELETE /api/s/<slug>/folders?path=…`
  (`api.folderDelete`). The core holds one prefix mutation fence while it re-enumerates
  and removes every note under the folder (journaled per-note), then `removeDir`s
  the subtree (markers + nested empty dirs); server-owned project/folder registry cleanup
  finishes before that same fence is released. A concurrent in-process stale update either
  lands before the deletion and is tombstoned, or runs afterwards and conflicts; a fresh create
  admitted after deletion may intentionally create the path again. Neither can be erased outside
  history. Out-of-band filesystem writers remain outside this process-local
  guarantee (the storage-level follow-up is documented in `core.md#write-through`).
  The confirm still names the note count (a `total`-only fetch).
  Previously the client looped `delete_note` so the folder would prune with its last
  file — that broke once folders became durable (never-prune) AND silently missed
  notes beyond the first page; the single server op fixes both.
- **Multi-delete (#206):** the tree context menu sends the effective selected set to
  one client-side batch helper. It dedupes nested selections first: if a selected
  folder contains another selected folder or note, the outer folder delete covers the
  descendants and they are not deleted twice. Notes still use `api.noteRemove`; folders
  still use `api.folderDelete`; the helper refreshes the union of touched parent
  folders, reloads project badges when any folder was deleted, clears the reader if
  the open note was removed, and the sidebar caller then drops the transient selection.

### Menu dismissal & highlight
- The popover closes on outside click, another right-click, Escape, scroll (capture),
  resize, or picking an item. It flips back inside the viewport near edges.
- The row whose menu is open gets `.context-target` (a neutral outline, **not** the
  selection's grey fill — it must not read as "opened"; the tree has no accent
  highlight at all, #103/#229).

## 7. Native HTML5 DnD mechanics (matters for tests)

### Responsive-drop recipe — build it into EVERY drag surface (don't re-explain it case by case)

Native HTML5 DnD has three traps that each read to a user as "the drop didn't work / I have to
go slow and hold." Every drag surface we add (tree move, list reorder, external-file import,
anything future) MUST bake these in from the start — they are the default, not a per-feature
fix the owner has to re-report:

1. **Active-drag state lives in a synchronous slot (a `ref` / module var), NEVER React state.**
   React state commits a frame late; a fast drag reaches `dragover`/`drop` before it lands, and
   a guard reading stale state misbehaves. Set the slot on `dragstart`, read it synchronously in
   `dragover`/`drop`. (Tree: `currentDragItems()` module slot. Reorder: the `active` ref.)
2. **`dragover` calls `preventDefault()` UNCONDITIONALLY while a drag is live.** This is the ONLY
   thing that makes an element a valid drop target — skip it and the browser fires **no `drop`**,
   so the row "stays put" until you hover long enough for lagging state to catch up. Never gate
   `preventDefault` behind async state.
3. **The whole surface is the drop zone, and the commit is WYSIWYG.** Make the container (not
   just each row) a drop target so a release in an inter-row **gap** isn't lost; and commit to the
   target the **indicator showed** (tracked synchronously on `dragover`), not a value recomputed
   from the drop event (which disagrees at row edges / on jitter). "Where the line points, that's where it lands."

Cosmetic state (highlight, drop-indicator line, dragged-row fade) MAY be React state — it can lag
without breaking the drop. Only the *decision path* (is-a-drag-active, what's-the-target, is-this-
a-valid-drop) must be synchronous. Reference impls: `libs/dnd/dnd/dnd.ts` (tree) + `libs/dnd/
reorder/reorder.ts` (list). History: #94 (tree fast-drop), #210 (reorder fast-drop + gap/WYSIWYG).

- `dataTransfer` is **unreadable during `dragover`**, so the active payload is stashed in a
  module-level slot (`currentDragItem()` in `dnd.ts`), set on `dragstart`, cleared on
  `dragend`. `readDrag()` falls back to it on `drop`.
- Drop targeting is resolved at the **section** from the row under the pointer
  (`data-drop-folder` + `closest`), so deepest-folder-wins falls out of DOM nesting — no
  per-row `stopPropagation` is needed (drag events bubble freely to the one section handler).
- Testing DnD: dispatch a `DragEvent` sequence (`dragstart` → `dragover` → `drop` →
  `dragend`) sharing one `DataTransfer`, on the row's **wrapper** (`tree-note`'s
  `parentElement` — the element carrying `data-drop-folder`) so it bubbles to the section.
  Because the section reads the target at the *drop* event, `dragover` and `drop` can target
  **different** rows — that's the fast-drop invariant (`move-refresh.spec.ts`): the move
  follows the row released on, not the last hovered. Native drop *timing* (a real fast
  release) can't be driven by Playwright, same as the #68 point 7 auto-scroll. Highlight state is
  React state — assert it on a **later tick / re-render**, not synchronously inside the dispatch.

### List reorder — a SEPARATE primitive from the tree move (#210)

The tree DnD above decides **drop VALIDITY into a container** (`canDropInto`). The context
constructor's Pinned list (`Agents → Context`) needs a different interaction: **reorder within
a list** — a drop lands BETWEEN rows, producing a new order. That lives in its own primitive,
`libs/dnd/reorder/reorder.ts` (`useReorder` + the pure `reorderKeys`), NOT in `dnd.ts`.

- Every row is a draggable handle (the whole `ContextCard`, a grip glyph is the affordance);
  `onDragOver` picks **before/after** from the pointer Y vs the row midpoint; the target card
  shows an inset accent line (`data-drop="before|after"` on `DisclosureCard`).
- It follows the **responsive-drop recipe** above verbatim: `active` + `target` refs
  (synchronous), unconditional `dragover` preventDefault, the list container (`listProps`) as
  the drop zone so a gap-release lands, and the commit goes to the indicator's target — not a
  recompute. This is why it feels instant with no slow-hover; do NOT regress it to state-gated.
- Each list owns **its own** `useReorder` instance, so a nested list (a set's items inside the
  pin list) never reacts to the outer list's drag — the outer instance's `active` ref is null
  while the inner one is active.
- Order = **load priority** (#210): the new sequence is persisted as a per-scope overlay
  (`context_order` facet) and the server curates the budget trim in that order — so the pult's
  order IS the agent's load order. Pins and sets share one rank space (a set can outrank a pin).
- `reorderKeys` is pure (permutation-invariant) and unit-tested (`test/unit/reorder.test.ts`).

---

## 8. Engine behavior that shapes the tree (notarium engine, #69/#78/#97)

The backend is the **own notarium engine** (`packages/engine`). Some of these rules
were carried over from the engine the project originally ran on (the "# Move Failed"
tool error); others — the empty-folder story — were deliberately INVERTED in #97.
(Historical note: pre-#69 this section described the prior engine's quirks; the
move-failure and identity rules survived the engine swap, the pruning rule did not.)

1. **Identity is the frontmatter `notarium-id` + the server's identity registry**
   (P7, #51) — never a storage permalink (a permalink frozen at creation is useless
   after a move; we don't depend on it). Since #54 the wire carries the
   note-id as THE reference, plus `filePath` as the storage view for the Files
   surface. All client references (URLs, caches, graph nodes, `data-id`) key on
   `note.id`. A move/rename keeps the id (and the `/n/<id>` URL), so the reader just
   reloads in place.

2. **A note move is id-addressed**; the registry resolves the note's space (#16).
   `GET /api/note` probes by id and the wiki-link resolver channel still accepts a
   storage key (path/title/**alias**) WITHIN a space — a renamed note's former
   title resolves through its alias-history (#100), so inbound `[[Old Title]]`
   never break. The link layer is id-first → current name → alias; the engine
   never rewrites the linking notes' bodies (the "inbound links rewritten" claim
   was a long-standing myth, untrue for this engine).

3. **A folder move is `isDirectory`** + directory paths (no `.md`), space-scoped
   (`POST /api/s/<slug>/move-folder`). It relocates the whole subtree; a MARKED
   folder carries its `.notariummeta` with it (one `fs.rename`), and the server
   re-prefixes the derived project rows (#13 I3). An EMPTY folder (no indexed notes —
   an empty project or a "New folder") moves too: the engine asks the **disk**
   (`dirExists`), not the note index, so it no longer fails `folder not found` (#97 point 3).
   Core claims both source and destination prefixes plus the subtree's stable note ids,
   so child mutations cannot interleave with the physical rename and independent folders
   remain concurrent.

4. **A failed move is a `# Move Failed …` tool error** (the engine surfaces it the
   same way every engine does). `/api/move` / `/api/s/<slug>/move-folder` turn it into
   a 400 so the UI shows an error instead of silently doing nothing.

5. **Empty folders are FIRST-CLASS and durable (#97 — INVERTS the old prune-on-empty rule).**
   The engine no longer prunes an emptied directory (`pruneUp` is gone, "never-prune",
   Obsidian-style): moving/deleting the last note out of a folder leaves the folder
   standing. The **directory channel** (`store.listDirs()` — a separate dot-aware FS
   walk, never mixed into the note index) surfaces every folder, empty or not; the
   server's `/tree` unions it with the project registry so the skeleton is
   authoritative (the client no longer synthesises project folders — that retired
   `withProjectFolders` and the dup-on-rename race). "New folder" (`makeDir`) creates
   a durable empty dir; deleting one is the explicit `removeDir` (folder-delete
   endpoint, §6b). Issue #7 ("show empty folders") is thus simply DONE.

6. **A folder gets a LAZY stable identity on its first rename/move (#100 phase 3).** A
   plain folder has no id until it needs one; the first `/move-folder` mints a
   stable folder-id and records the OLD path in the folder's **path-history**
   (`recordFolderRename`). (Creating a folder PAGE is the OTHER lazy-mint trigger —
   `ensureFolderIdentity`, #212, so the durable `/folder/<id>` is addressable; see
   [folder-page.md](folder-page.md).) Identity lives SERVER-side: a `.notariummeta` marker
   (the same dotfile as a project, now carrying `type: 'folder'` + `pathAliases`,
   so it travels with the folder and survives a re-clone) + a row in the shared
   `folders` meta-DB table (a project is a `type='project'` row of the SAME table).
   The engine never reads the marker — folder identity is a server concern — so the
   read-model FEEDS the engine the path-history (`setFolderAliases`) and that's how
   the engine resolves a path-form `[[oldpath/note]]` to the renamed folder's note
   even when the filename is ambiguous — in BOTH its boot graph (`buildLinkIndex`)
   AND its direct reference resolver (`resolveRow`, the server's
   `GET /api/s/:space/note?ref=` channel that a client hits on a cache-miss, #125).
   Both mirror the client's `resolveWiki` algebra: literal full-path → folder-alias
   prefix-rewrite → bare last-segment, the literal kept STRICTLY above the alias
   (a live note at the exact path wins, like `buildLinkIndex` Pass 1 > Pass 3). The
   read-model additionally heals ghosts. Two outcomes ride on the path-history:
   `[[oldpath/note]]` keeps resolving, and `/files/<oldpath>` redirects to the
   current path (`/tree` carries
   each moved folder's `id`+`aliases`; the client `canonicalFolderPath` redirect is
   the folder twin of the note's stale-slug redirect). Marking such a folder as a
   project ADOPTS its id (the row flips type in place). The MCP folder rename/move
   tool stays gated on #102 — phase 3 is the foundation, like phase 2 for projects.

---

## 8b. Explorer view scope — Files / Projects / single project (#164)

The FILES header is a minimalist **scope picker** (`ScopePicker` in `Sidebar.tsx`): just the label (no chevron — a hover/open background pill is the only affordance), opening the shared `ContextMenu`. This is a PURE CLIENT filter over the same server-authoritative skeleton (§8.5) + the project registry (`ProjectsProvider`) — no contract/engine change; the skeleton already carries every folder and `projectAt` already knows which are projects.

The picker dropdown carries the **two modes** — Files / Projects — plus up to **five recently-focused projects** as quick-jumps (a divider separates them). It does NOT enumerate ALL projects (a flat list doesn't scale past a handful; this was a deliberate revision of the first cut). A project not yet in the recents is **FOCUSED from its own row's context menu** ("Focus project" — the same per-item action surface as Mark/Rename/Delete, scalable to any number of projects); once focused it enters the recents for one-click return. The header label then shows the project's name, and picking Files/Projects leaves the focus.

The "recent" signal is a **client-side MRU** (`pushRecent`), kept in `localStorage` per space (`notarium.recentProjects:<space>`), keyed by the stable project **id** (survives rename/move) — NOT a server signal: `projects.lastSeen` is a marker-scan timestamp (not human activity) and `createdAt` isn't on the wire, so a clean MRU over the focus action is the no-hack source. Recents that no longer resolve to a live project (unmarked/deleted) are filtered out at render; the root project is never a recent.

- **Files** — the whole tree from the space root (the historical behaviour, the default).
- **Projects** — only the marked projects. The **outermost** non-root projects become the top-level rows; a project nested under another stays IN PLACE in its parent's subtree (its own badge, shown once — no duplication, which dissolves the "project-in-project recursion" worry). Root-level notes and plain (unmarked) folders are hidden. Empty → an actionable `projects-empty` state.
- **Single project** (context-menu "Focus project") — re-rooted to that project: the tree shows only its CONTENTS at depth 0 (the project's own row is implied by the header label, not repeated). The scope's "root" — the empty-area drop zone and the New note/folder default — becomes the project's folder, not the space root.

**The space root project is excluded everywhere** (it offers no "Focus project", and never appears as a Projects-forest root). A space's root is auto-marked (#97/#13 point 5), so a root-inclusive view would just equal Files — the value here is the sub-projects you made. The pure helpers (`outermostProjects`, `nearestProjectPath`, `scopeHidesFolder`, `findSkeletonNode`, `pushRecent`) live in `libs/tree/tree/explorerScope.ts`; the project-scoped ones treat `''` as non-project by construction.

**Persistence.** The scope is remembered per space in `localStorage` (`notarium.explorerScope:<space>`), so a focus survives a reload; a space switch reloads that space's stored choice. A focused project that no longer exists (unmarked / deleted / absent after a switch) falls back to Files.

**Out-of-scope reveal (Q3).** Opening a note the current scope would HIDE bounces the explorer back to Files, so the invariant "the open note is always revealable in the tree" (§5) holds — a search hit or wiki-link into a foreign folder never silently vanishes from the rail. It is keyed on the OPEN NOTE (and the projects-ready transition at boot), NOT on a scope change, so a deliberate focus while a foreign note is open is preserved — only NAVIGATING to a foreign note resets it. The boot path matters: a deep-linked note under a stored foreign focus resets the moment the project registry lands (`projectsReady` false→true is a trigger). **It must NOT act while `navigating`** — at boot `nav.folder` is the seeded `''` placeholder until the note resolves, and `''` reads as out-of-scope for ANY project scope; acting then would wrongly bounce a valid IN-scope deep-link to Files. The `navigating` guard defers the check until the note's real folder lands (then the effect re-fires on the `nav.folder` change). Symmetrically, the project-gone fallback (a focused project that was unmarked/deleted/absent after a space switch → Files) is gated so it never trusts the PREVIOUS space's project list mid-switch.

### DnD seam — nesting a project is allowed (#164)
The issue floated a guard ("don't let a project be dragged into another project in the flat view") to dodge a project-in-project **recursion/duplication** worry. That worry was the SYMPTOM; it's solved at the RENDER layer instead — Projects view shows a nested project once, in place under its parent (see `outermostProjects`). With the root cause gone, there is **no project-specific DnD ban**: nesting a project under another is a legal reorganization (the data model supports nested markers, nearest-ancestor wins; a folder move carries the `.notariummeta` + re-prefixes the rows), the Projects view reflects it honestly, and it's reversible. DnD validity is therefore the **same pure `canDropInto` rules in every scope** — only the illegal cases (onto self / its current parent / its own descendant) are barred, exactly as for any folder. The only scope-specific DnD detail is `dropTargetAt`: the empty-area target is the scope's root (the focused project in single-project view, else the space root), not always the space root.

---

## 9. Test checklist

Backend (`packages/server` + `packages/engine`, can hit `/api/*` against the engine or the e2e fake):
- [ ] `POST /api/move` note into a subfolder, into root, and out of root (bare-slug id → `.md`).
- [ ] `POST /api/move` folder (`is_directory`) into another folder and back; subtree relocates.
- [ ] `POST /api/move` to an invalid identifier → 400 (Move Failed detected, not 200/ok).
- [ ] `GET /api/note` for a moved note and a **root** note → resolves; `filePath` reports
      the note's current location (never the frozen permalink).
- [ ] `GET /api/note` by **note-id** resolves (the registry channel); by **title** still
      resolves too (probe order `[id, id+".md"]` — the wiki-link resolver channel).
- [ ] Identity invariants (#51, covered by test/store-contract): rename via
      `originalId` and `POST /api/move` keep the note's `id`; an unknown id → 404.
- [ ] Alias-history (#100, covered by test/store-contract `rename-aliases`): rename a
      note's title (incl. cyrillic / camelCase) → an inbound `[[Old Title]]` stays a
      REAL graph edge (not a ghost) AND `GET /api/note?ref=<Old Title>` resolves to it.
- [ ] Folder-alias DIRECT resolve (#125, covered by test/store-contract `folder
      path-aliases`): with `setFolderAliases([{current,alias}])`, `read('alias/Note')`
      resolves to the renamed folder's note, NOT an ambiguous filename sibling — and a
      LIVE literal `alias/Note` still wins over the rewrite (literal > folder-alias).

`canDropInto` / `droppableInto` / `canDropAnyInto` (`packages/web/src/libs/dnd/dnd/dnd.ts`, pure unit tests in `test/unit/dnd.test.ts`):
- [ ] note: same folder → false; different folder → true; into root from a folder → true.
- [ ] folder: self → false; current parent → false; descendant → false; unrelated → true.
- [ ] **set (#163)**: `droppableInto` keeps the movable members and drops no-ops; skips an illegal folder (into its own descendant) while keeping a sibling; an all-already-there set → `[]` and `canDropAnyInto` false; an empty set is never droppable.
- [ ] **`rangeSelect` (#163)**: ranges the inclusive run between anchor and click in EITHER direction; skips a non-selectable (skeleton) row; a single-row range = just that row; returns null when the anchor is gone or the index is out of bounds (caller degrades to single-select).

Tree (`packages/web/src/libs/tree/tree/tree.ts`):
- [ ] `buildTree` nests files under folders; root files appear at top level; folders sort
      before files; stable order.

Explorer scope (`packages/web/src/libs/tree/tree/explorerScope.ts`, pure unit tests + `test/e2e/projects-explorer.spec.ts`):
- [ ] `outermostProjects`: a top-level project is taken without descending (nested project stays inside); a project buried under plain folders surfaces as a top-level row; root excluded.
- [ ] `nearestProjectPath` / `scopeHidesFolder`: Files hides nothing; Projects hides folders outside every (non-root) project; single-project hides everything but its subtree (prefix-boundary, not substring).
- [ ] `pushRecent`: prepends a new id; moves an existing id to the front (dedup); caps at 5 (drops the oldest).
- [ ] e2e: Files→Projects→single-project switch (nested project shown once, plain folders hidden); a focused project becomes a recent quick-jump in the dropdown; opening an out-of-scope note bounces to Files; Projects-empty state until a folder is marked.

Sidebar interactions (component / DnD tests — mind the native-DnD mechanics in §7):
- [ ] **Plain** folder click toggles expand/collapse; no folder gets `.active`/selection highlight, and it clears any multi-selection.
- [ ] Open a file → only that file highlighted; no folder highlighted.
- [ ] **Active vs selected are visually distinct (#229, `test/e2e/tree-active-selection.spec.ts`)**: an open note keeps the light `--bg-hover` pill while a selected-only row is a DENSER `--border-strong` grey — different `background-color`, no accent; a row that is BOTH open and selected also carries a neutral left border (`::before`), so all three states are distinct; ctrl-clicking the OPEN note toggles it into the set VISIBLY (its pill deepens + gains the border; the row becomes both `aria-current` + `aria-selected`); deleting a set that includes the open note carries it too (the issue's example); a plain click on the open note clears the set but keeps it active (Model 1 — the set is the explicit pick, the open note does not auto-join). The gap between rows survives selection (background-color keeps `background-clip`).
- [ ] **Multi-select move (#163, `test/e2e/multiselect-move.spec.ts`)**: ctrl/cmd-click several notes (across folders) → each `aria-selected`; drag the set onto a folder → all land there in one drop, none lost. Ctrl-click several folders (a ctrl-click does NOT expand them) → drag into another folder → every subtree relocates under it (the old top-level rows gone). **Shift-click** ranges the rows between anchor and click. A **mixed** set (a folder + a note) moves together in one drop. Plain click clears the set; Escape clears it.
- [ ] **Multi-select delete (#206, `test/e2e/multiselect-delete.spec.ts`)**: ctrl/cmd-click several rows → right-click one selected row → menu says `Delete N items`; confirming removes the whole effective set and clears selection. Right-clicking an unselected row while another set is selected clears that set and opens a single-target menu. Selecting a folder plus a descendant note/folder deletes the outer folder once, with no duplicate child delete/toast.
- [ ] Drop onto a **child file** inside an expanded folder → lands in that folder; only the
      **parent folder's row** highlights (not the child, no subtree wash).
- [ ] Nested precedence: drop onto a file in a nested subfolder → the **subfolder** (not its
      parent) is the target.
- [ ] Drop onto the empty area / a root file row → moves to **root**.
- [ ] **Same-folder no-op**: drag a file onto a sibling in the same folder → **no** highlight
      anywhere (especially not root), and the drop does nothing.
- [ ] Transition empty-root-hover → sibling-file-hover clears the root highlight.
- [ ] After moving the open note, the tree reveals (expands to) and highlights it; `nav`
      points at the new folder.
- [ ] **Reveal-on-sync** (#161, `test/e2e/deep-link-reveal.spec.ts`): with a note open,
      *Collapse all* then *Refresh* re-expands the chain to the active note (its row returns +
      highlights); scrolling the rail away then *Refresh* scrolls it back into view below the
      glass head (the per-note latch is re-armed, the inset clears the head). On a chrome
      surface (graph) *Refresh* does NOT reveal the retained note. Three independent tests —
      a regression in expand / scroll / gate fails exactly one.
- [ ] Search query → results render in the rail; `Recent` → recent list; clearing → tree.

Context menu & inline rename (issue #15):
- [ ] Right-click a folder → New note / New folder / Rename / Copy path / Delete (#97).
- [ ] New folder creates a durable empty folder shown in the tree; it survives the
      last note leaving its sibling (never-prune). Delete a folder → server removes
      its notes + the dir in one call.
- [ ] Right-click a note → Rename / Duplicate / Copy link / Delete.
- [ ] Right-click the empty tree area → New note (at root).
- [ ] Right-click a note inside an expanded folder → the **note's** menu, not the folder's
      (deepest target wins; matches DnD precedence).
- [ ] Rename a note → Enter commits (file moved, not duplicated); Escape cancels; empty/unchanged is a no-op.
- [ ] Rename a folder → subtree relocates; an open note under it stays open and re-points.
- [ ] Delete a folder → confirm names the note count; all notes under it go; folder disappears.
- [ ] Menu dismisses on outside click / Escape / scroll / second right-click; flips inside the viewport at edges.

---

## 10. External-file drop → import (#223)

A SECOND drag-and-drop lives in the app, orthogonal to the tree move above: drag a
text file from the OS into the window → import it as a note. The two never fight
because they ride **different payloads** — a tree move carries the custom
`application/x-notarium-item` mime (§7), an OS file drag carries **`Files`** in
`dataTransfer.types` (the one field readable during `dragover`). Every file-drag
handler gates on `isFileDrag(e)` (= `types` includes `Files`); an internal move reads
`currentDragItems()` (empty for an external drag). Two disjoint payloads, same events.

### It rides the SAME import machinery (#191), not a parallel path
The dropped file goes through `useFileImport()` → **`api.importStart`** — the exact
client #191 built for the Settings tab: in production it stages the upload + enqueues
a **durable import job** (`202 + Job`, tracked to terminal via `pollJobToTerminal`);
on a host with no job layer it answers with the synchronous NDJSON stream. Both drive
to the same `ImportSummary`. So a drop is durable, cancelable and restart-surviving for
free, and there is ONE import path, not two. The only DnD-specific addition on the core
is the **`markdown` format** (`core/services/import/markdown.ts`) — a plain `.md`/`.txt`
→ one note — FORCED by the client (the extension is the signal; a markdown body can
start with `{`/`[`, so content-detection would misfire). That format benefits every
import surface, including a `.md` dropped into the Settings tab. See [import.md](import.md).

- **Each dropped file is its own import** (#191 stages one upload per job), so a
  multi-file drop is N imports whose summaries `useFileImport` folds together for the
  toast. `skipExisting` is on — a casual drag never clobbers an existing note.
- **A single-file drop OPENS the note** right after (its id comes back in the summary's
  `created[]`, capped server-side; `noteRoute(id)`). A multi-file drop does NOT jump —
  the notes just stream into the tree (via the SSE `changed` event as each job writes).

### Two drop zones, each with the cue that fits it
- **The tree (rail) is owned by the Sidebar section.** `sectionDragOver`/`sectionDrop`
  branch on `isFileDrag(e)` FIRST: a file drag lights the exact target folder row with
  the SAME `dropTarget`/`.drop-target` highlight as an internal move (root → the section
  `.drop-root` wash), and every folder is a valid import target (no self/descendant rules
  — those are for MOVING items). The drop calls `useFileImport()(files, dropTargetAt(e))`.
- **The content (reader) is owned by the window dropzone** (`ImportDropZone.tsx`, mounted
  in `App.tsx`). It acts only when the pointer is NOT over the tree
  (`!el.closest('[data-scope-root]')` — the section owns that). The whole reader lights —
  a **light frosted (`backdrop-filter: blur`) neutral wash** over `main`'s rect + a dashed
  border (the neutral `--text` tint matches the tree's `.drop-root`, so both zones read as
  one system) — with a **centred card** naming the target ("Drop to import into <folder>").
  No cursor-following label (it fought the OS's own "copy" drag badge, which the page can't
  suppress). All `pointer-events:none` so `elementFromPoint`/the drop reach the content.
- **Content-zone target = the OPEN note's folder** (drop it next to what you're reading),
  else the current scope root. The Sidebar publishes both on `.folders-section`:
  `data-open-folder` (the open note's `directoryOf(filePath)`, absent when none open) and
  `data-scope-root` (the focused project's folder, else the space root).

### Test checklist (external-file import)
- [ ] Drop a `.md` in the reader (no note open) → scope root; onto a folder ROW → that
      folder; with a note open, in the reader → the note's folder (`test/e2e/import-dnd.spec.ts`).
- [ ] A single-file drop opens the imported note; a multi-file drop imports all, opens none.
- [ ] `markdown` import rides the durable job AND the sync fallback, returns `created[]`
      (`test/fake-server/import.test.ts`); `markdownFileToNote` unit (`…/import/markdown.test.ts`):
      H1 > filename title; frontmatter stripped; deterministic per-basename filename; BOM tolerated.
- [ ] An internal tree move still works with the file-drag handling added (payloads disjoint).
