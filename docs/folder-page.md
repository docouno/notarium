# Folder page (#212, FOLDERS epic)

> Any folder can have a **page** — a section overview/body, like a parent page in Notion
> and a folder-note in Obsidian. The foundation for clickable breadcrumbs and section links
> ([FOLDERS][B] children summary #213, [FOLDERS][C] breadcrumbs+icon #214 — on top of this core).

## Model

- **A folder page = a visible `index.md` (class `user-doc`) INSIDE the folder itself.**
  Recognized by a reserved name — the constant `FOLDER_PAGE_FILENAME = 'index.md'`
  (`packages/core/src/libs/path/path.ts`). This is an ordinary note: it lands for free in the
  graph/search/indexing, is edited/versioned by the standard note-reader — **zero bespoke**.
  Only its name gives it the meaning of "folder body".
- **NOT in `.notarium/`.** That mount is for hidden service classes (agent-memory/profile,
  `userSearch/graph/tree=false`, #78/P11). A folder page, on the contrary, MUST be in the graph/search/
  links, so it lives as a sibling in the folder itself (like the `.notariummeta` marker — deliberately
  not under `.notarium/`).
- **Hidden from the children list.** `index.md` is the folder's "cover", not its child: it is excluded
  from the tree/summary (treeChildren/treeSummary) and from their counters (`core/listing.ts`,
  `isFolderPageNote`). It stays visible in the graph/search/direct addressing (a different code path).
  Breadcrumbs also drop the leaf segment `index` (`DocumentLayout`).

## Addressing — `/folder/<id>` (durable, by folder-id)

- **The route `/folder/<id>`** — space-free, like `/n/<id>`: the registry resolves the space (`GET /api/folder/:id`).
  folder-id is stable across rename/move (id-in-marker, file-first), so the link **never
  breaks** — we do NOT make the path the identity (the Logseq/Dendron/Foam anti-pattern, P11/#74-F1);
  identity = id-in-file, path is only a navigational alias with an alias-redirect (#100 phase 3).
- **folder-id is minted LAZILY on page materialization** (plus the existing mint on move,
  `recordFolderRename`). This is the ONLY trigger, besides move, that writes the `type:folder` marker
  (`ensureFolderIdentity`, `markFolder.ts`) — so `.notariummeta` appears only after
  the page description is first saved (or a move), and is NOT spawned for every viewed folder.
- **Resolution and surfaces:** `/folder/<id>` → page exists → redirect to its note `/n/<pageNoteId>`
  (the body in the standard reader); no page → redirect to `/s/<space>/files/<path>` (a virtual
  folder-page: folder title + children summary, without materialize). A folder WITH a page, when entered
  via `/files/<path>`, also shows the body (FilesPage redirects to `/n/<pageNoteId>`). A folder
  WITHOUT a page and not moved is addressed by path; the marker is not written.

## Page materialization — lazy save

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
  writes neither a cover note nor a folder marker.

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
  `id?` is now on ANY identified folder (page-bearing/moved/project), not only a moved one,
  so the client can build `/folder/<id>`. `folderIdentitiesFor` (server) merges the folder- and
  project-rows of the registry.
- `FolderResponse` (`GET /api/folder/:id`): `{ folderId, space, path, name, pageNoteId? }`.
- `CreateFolderPageRequest`/`CreateFolderPageResponse` (`content`/meta fields are optional for
  materialize-on-save).

## Seams (files)

- core: `libs/path/path.ts` (`FOLDER_PAGE_FILENAME`/`BASENAME`, `isFolderPageNote`,
  `folderPageFilePath`); `services/listing/listing.ts` (hiding from children+counters, `pageNoteId`).
- server: `projects/markFolder.ts` (`ensureFolderIdentity`); `api/api.ts`
  (`POST /folders/page`, `GET /api/folder/:id`, extended `folderIdentitiesFor`).
- web: `routePaths` (`/folder/<id>`, `folderPageRoute`); `App.tsx` (route); `pages/FolderPage`
  (resolver-redirect); `pages/FilesPage` (virtual folder-page without materialize);
  `composers/FolderChildrenSummary` (direct children under the body/virtual title);
  `EditingProvider` (materialize-on-save); `Sidebar` (the "Open page" item); `DocumentLayout`
  (breadcrumb without `index`, Edit for a virtual folder-page).

## Related

- `docs/projects.md` — folder-identity (#100 phase 3), the `.notariummeta` marker, the `folders` registry.
- `docs/drag-and-drop.md` §8.6 — lazy folder-identity, alias-redirect of the old path.
- #213 [FOLDERS][B] children summary under the body · #214 [FOLDERS][C] clickable breadcrumbs + icon.
