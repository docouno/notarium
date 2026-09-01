# Folder page (#212, FOLDERS epic)

> **Folder page** is the term every surface uses WHERE IT NAMES the role — the reader's pin action, the context panel, the MCP contract and this doc. A surface that names it nowhere — a board card — says nothing rather than something else. `index.md` is its STORAGE name and appears only where the file itself is explained.

> Any folder can have a **page** — a section overview/body, like a parent page in Notion
> and a folder-note in Obsidian. The foundation for clickable breadcrumbs and section links
> ([FOLDERS][B] children summary #213, [FOLDERS][C] breadcrumbs+icon #214 — on top of this core).

## Model

- **A folder page = a visible `index.md` (class `user-doc`) INSIDE the folder itself.**
  Recognized by a reserved name — the constant `FOLDER_PAGE_FILENAME = 'index.md'`
  (`packages/core/src/libs/path/path.ts`). This is an ordinary note: it lands for free in the
  graph/search/indexing, is edited/versioned by the standard note-reader — **zero bespoke**.
  Only its name gives it the meaning of "folder body".
- **The body a project loads is still that ordinary note.** When the folder is an active project and
  its page exists, the first lifecycle transition that brings those two facts together adds the
  ordinary same-space `always-load` tag to `index.md`: the project's first page save, the first mark
  of a folder whose page already exists, or a page ARRIVING at an active project's root by
  `move_note`. To find who decides, grep `setNotePinned` (the writers) and `markFolderAsProject` (the
  mark doors) — and note that not every mark door pins: the first-boot root mark
  (`apps/server/server.ts`, `onProvision`) looks for no page and pins nothing. Marking does not
  materialize a missing page.
  Manual Unpin is respected by later edits and repeated marks; `unmark → mark` starts a new project
  lifecycle and pins the existing page again. Where a surface names this note's role it says `Folder page` —
  the UI label, the REST agent-context marker (`folderPage`) and the MCP contract; the tag does not
  mean that the folder's children are loaded. Auto-pin is a post-primary,
  best-effort metadata step: once page creation or project marking has succeeded, a tag-write
  failure is logged but does not roll that lifecycle operation back. An idempotent repeated mark
  does not retry it; `unmark → mark` opens the next lifecycle transition.
- **NOT in `.notarium/`.** That mount is for hidden service classes (agent-memory/profile/skill,
  `userSearch/graph/tree=false`, #78/P11). A folder page, on the contrary, MUST be in the graph/search/
  links, so it lives as a sibling in the folder itself (like the `.notariummeta` marker — deliberately
  not under `.notarium/`).
- **Hidden from the children list.** `index.md` is the folder's "cover", not its child: it is excluded
  from the tree/summary (treeChildren/treeSummary) and from their counters (`core/listing.ts`,
  `isFolderPageOf`). It stays visible in the graph/search/direct addressing (a different code path)
  and in saved views: a board over a project lists a page as an ordinary row and counts it in the
  view's `total`, deliberately — a folder used as a RECORD (a task, a research package) keeps its
  facts on its page, and that page is exactly the card such a board wants. A view `total` is
  therefore not comparable with a folder's own counts at all — it counts the rows this source and
  these filters select across the source's whole scope (a project subtree, or an entire space), while
  `list_notes.total` counts the direct notes of ONE folder that pass that call's own tag/field filter,
  and `index.noteCount` the project subtree minus its pages.
  Breadcrumbs also drop the leaf segment `index` (`DocumentLayout`).

## Addressing — `/folder/<id>` (durable, by folder-id)

- **The route `/folder/<id>`** — space-free, like `/n/<id>`: the registry resolves the space (`GET /api/folder/:id`).
  folder-id is stable across rename/move (id-in-marker, file-first), so the link **never
  breaks** — we do NOT make the path the identity (the Logseq/Dendron/Foam anti-pattern, P11/#74-F1);
  identity = id-in-file, path is only a navigational alias with an alias-redirect (#100 phase 3).
- **folder-id is minted LAZILY, never for a merely viewed folder.** Something durable has to happen to
  it — its page is materialized, a page arrives by `move_note`, the folder is moved, renamed,
  favorited, or marked as a project (a project id IS its folder id, which is why
  `folderIdentitiesFor` reads both registries). **Read that as examples.** To find the mints, grep
  `freshNoteId` under `services/projects/`; note that `markFolderAsProject` mints its own and does
  NOT go through `ensureFolderIdentity` — the dependency runs the other way, `folderIdentity.ts`
  imports `writeMarkerFor` from it. Every list of these written here so far has gone stale. **`.notariummeta` is not that identity's private file** either:
  project marking shares it, including the root marking every space receives on provision, and so
  does the space facet (`spaceIdentity.ts`). So the marker answers the page question in NEITHER
  direction — it sits on a page-less folder whenever any act minted an id, and an unmark drops the
  project row, and with it the identity a page-bearing folder had (at a space ROOT the marker file
  survives, rewritten with the space facet alone). `pageNoteId` is what answers it
  (`contract/schemas/rest/tree.ts`).
- **Resolution and surfaces:** `/folder/<id>` → page exists → redirect to its note `/n/<pageNoteId>`
  (the body in the standard reader); no page → redirect to `/s/<space>/files/<path>` (a virtual
  folder-page: folder title + children summary, without materialize). A folder WITH a page, when entered
  via `/files/<path>`, also shows the body (FilesPage redirects to `/n/<pageNoteId>`). A folder with no identity is addressed by path and carries
  no marker — and note the asymmetry: deleting a page does not take back an id already minted.

## Page materialization — lazy save <a id="page-materialization"></a>

- `POST /api/s/<space>/folders/page` body `{ folderPath }` → `{ folderId, pageNoteId, path }`.
  Mints the folder-identity (if absent) + writes `index.md` (`store.write` with `fileName='index'`,
  `targetClass:'user-doc'`, `ifExists:'fail'`). 409 if the page already exists; 404 if the folder is absent.
  The default title = the folder name; the body — `# <name>` for compatibility with old calls.
- The UI **does not show** the technical step "create page". A folder without an `index.md` already opens
  as a virtual page: folder title + direct summary. The `Edit` button opens a draft
  of the future page, but `index.md` is created only on the first `Save`, when the body/metadata
  have actually changed.
- The endpoint accepts optional note-write fields (`content`, `noteType`, `tags`, `slug`,
  `createdAt`), so the first save of a virtual page writes the user's body straight
  into `index.md`, without an intermediate empty revision.
- If another writer manages to materialize `index.md` between the draft start and `Save`, the UI treats
  `409` as a conflict: the draft stays in the editor, the user can view the saved
  version or explicitly save their own over it.
- Editing an already-materialized page preserves the reserved basename `index.md`;
  a heading inside the body does not turn the cover note into an ordinary `<title>.md`.
- **We do not spawn empty `index.md`**: opening a folder, viewing the summary, or cancelling a clean draft
  writes neither a cover note nor a folder marker. Marking the folder as a project also does not
  create a page just to provide agent context.

## Children summary under the body (#213)

- **The folder is self-sufficient before and after materialize:** if `index.md` exists, the reader shows direct
  children after the markdown body; if there is no page yet, FilesPage shows the same summary under
  the virtual folder title. This is the Notion pattern parent page → section catalog without a separate
  browse/CTA step.
- **The data source — `GET /api/s/<space>/tree/children?path=<folder>`.** No new backend is needed:
  the endpoint already returns the direct tree step, title-order and server-side excludes `index.md` as the cover.
  We do not duplicate the client-side cover-note filter.
- **Depth v1 — direct only.** Subtree, toggles and grid/card presentation belong to future
  modes (see #34), not to the base folder-page model.
- **Links:** an identified folder leads through the durable `/folder/<id>` (resolving to page/body or browse),
  a plain folder — through `/s/<space>/files/<path>`, a note — through `/n/<id>`.

## Wire / contract

- `TreeFolderSchema` (#212): `pageNoteId?` — the folder page's id (presence ⇒ a page exists);
  `id?` is now on ANY identified folder (page-bearing/moved/favorited/project), not only a moved one,
  so the client can build `/folder/<id>`. `folderIdentitiesFor` (server) merges the folder- and
  project-rows of the registry.
- `FolderResponse` (`GET /api/folder/:id`): `{ folderId, space, path, name, pageNoteId? }`.
- `CreateFolderPageRequest`/`CreateFolderPageResponse` (`content`/meta fields are optional for
  materialize-on-save).

## Seams (files)

- core: `libs/path/path.ts` (`FOLDER_PAGE_FILENAME`/`BASENAME`, `isFolderPageNote`,
  `folderPageFilePath`); `visibility/visibility.ts` (`isFolderPageOf` — the class-aware question every
  surface that ANNOUNCES the role asks: the MCP slot and marker, the REST carrier, the tree's
  `pageNoteId`, the reader's labels; a bare basename still EXCLUDES a cover from a listing or a
  counter, pins the reserved file name on write, or echoes a write this very call made);
  `listing/listing.ts` (hiding from children+counters, `pageNoteId`).
- server: `services/projects/folderPage.ts` (`folderExists`, `materializeFolderPage` — the one page
  lifecycle behind REST and MCP); `services/projects/folderIdentity.ts` (`ensureFolderIdentity`);
  `routes/folders/folders.ts` (`POST /folders/page`), `GET /api/folder/:id`, extended
  `folderIdentitiesFor`; `services/mcp/helpers/folderPage/` (the marker and the reserved-name guard
  shared by the MCP tools); `services/spaces/agentContext.ts` (the REST agent-context carrier, asking
  the same class-aware question); `routes/contextSets/contextSets.ts` (the paginated audit page
  of one context set — the SECOND source of rows for one expanded set, so it answers the same
  question rather than leaving the tail of a large set unlabelled).
- web: `routePaths` (`/folder/<id>`, `folderPageRoute`); `App.tsx` (route); `pages/FolderPage`
  (resolver-redirect); `pages/FilesPage` (virtual folder-page without materialize);
  `composers/FolderChildrenSummary` (direct children under the body/virtual title);
  `EditingProvider` (materialize-on-save); `Sidebar` (the "Open page" item); `DocumentLayout`
  (breadcrumb without `index`, Edit for a virtual folder-page).

## Agent surface (MCP) <a id="agent-surface-mcp-415"></a>

The page is a **structural role**, not a new entity and not a new tool — the agent reads and writes it
with the ordinary note tools (#415).

- **`list_notes` carries a `folderPage` slot** for the folder it listed: `present` (with the page's
  `noteId`/`title` plus the server-derived `folderPath`/`folderId?`) or `missing` (with `createWith?` —
  the exact `create_note` arguments that would author one, offered only where this credential could
  actually perform it). The note's storage path is not repeated in the slot: `folderPath` identifies the
  structural owner and the note is addressed by id.
- **The page is not an item.** It leaves the direct-note population BEFORE any tag/field filter, cursor
  or `total`, so the slot is identical on every page of a filtered listing and no listing shows the
  cover twice. This replaced the previous behaviour, where `index` arrived as an ordinary item.
- **A path with no folder gets no slot** — and no error: the listing stays the empty answer it always
  was. Inventing a "folder that still lacks its page" would invite an agent to author into a ghost.
- **The prose mirrors the structured slot exactly**, including a folder that holds only its page (where
  the listing is otherwise empty). The missing branch states a capability and warns that a page is
  authored only on explicit request — never a to-do the agent picked up by browsing.
- **`create_note(folderPage: true)` is the one agent door.** It runs the same `materializeFolderPage`
  operation as `POST /folders/page` — folder existence, lazy identity minting, the page-already-exists
  collision, the folder move/delete race and the active project's `always-load` auto-pin are one
  implementation, not two. `createWith` saves the model a guess and authorises nothing: project, path,
  access and folder existence are re-resolved on every call.
- **The reserved basename is closed on every other door.** A create or rename whose RESOLVED basename
  (`noteFileBase(title, fileName)`) equals `index` is refused before mutation — including a plain
  `title: "Index"`, a `create_notes` item (which fails alone) and `rename_note`. Guarding only the raw
  `fileName` would leave the title door open, which is exactly the lifecycle bypass this closes. A note
  that already IS a page keeps renaming freely; the engine pins its basename. The refusal follows the
  door: a rename is told to pick another title, not to go and author a page nobody asked for. The
  question is asked of
  VISIBLE user-docs: hidden classes live in dot-namespaced mounts of their own, where an `index.md` is
  somebody's memory category and no folder's cover.
- **Moving a page re-homes a cover, and is allowed.** `move_note` keeps a note's file name, so moving
  a page makes it the destination's cover. That stays legal on purpose — a plain `mv` on disk does the
  same thing, and the file-first model must swallow it rather than pretend an API refusal makes it
  impossible. The destination folder then ADOPTS the page through the same lifecycle a create runs:
  where the host keeps a folder registry its identity is minted and an active project's root gets its
  pin. The decision is made once, by where the page ARRIVED: landing in an active project's root makes
  it the body that project loads whatever the last one thought, and leaving one without landing in another
  releases the pin — or the project would keep loading a body describing a folder it no longer covers,
  and a new root page would give it two. A ROOT project owns its whole space, so when its page moves to the
  ROOT of another ACTIVE project nested inside it, the page becomes the body that project loads, and the root
  project keeps loading it too — as an ordinary pin inside its subtree, not as its own cover, which its slot
  now honestly reports as missing. Anywhere else inside that space, including into a nested project that
  is not active or below its root, the pin is released like any other departure.
  The mint rides the move's
  `finalize`, not its `prepare` — a marker is metadata ABOUT a folder
  that exists and never provisions one, and `move_note` creates a missing destination, so before the
  move there may be no folder to mark; the late hook also leaves no row behind when a move refuses.
  Refused is the collision: moving a page onto a folder that already has one. The store refuses that
  destination anyway, with a bare `# Move Failed: a note already lives at the destination`; the
  pre-check answers it the way the create door does, naming the folder and the way forward, before
  anything is attempted. A page that ends up in a folder with no identity is not an error — the read
  surface reports it honestly, without an id.
- **`get_note` marks the page** it returns (`folderPage: {folderPath, folderId?}`) and says the role in
  prose too — the flow sends an agent from a present slot straight here, so this is where a text-only
  client would otherwise stop being told what it is holding. And
  **`start_session` reports a project's root page only when it exists** — a quiet bootstrap, with the
  body arriving through the ordinary always-load pin WHEN a lifecycle transition put one there. A
  vault adopted at first boot is the gap: its root is marked an active project by `onProvision`,
  which does not look for the page it already has, so that page is reported and never loaded.

Children summary/depth (#213/#312) is deliberately NOT part of this contract: the authored page and the
computed structure of a folder are different levels.

## Related

- `docs/projects.md` — folder-identity (#100 phase 3), the `.notariummeta` marker, the `folders` registry.
- `docs/drag-and-drop.md` §8.6 — lazy folder-identity, alias-redirect of the old path.
- #213 [FOLDERS][B] children summary under the body · #214 [FOLDERS][C] clickable breadcrumbs + icon.
