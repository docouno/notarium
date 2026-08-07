import type { SkeletonNode } from '../../libs/tree/tree'
import type { NoteDetailView, NoteView, Tree } from '../../libs/wire'

export type NavScope = { type: 'all' | 'feed' | 'folder'; folder: string }

/** Reader display state. Editing overlays this without erasing it ('read' stays
 *  underneath an edit so Cancel can fall back to the open note). */
export type ReaderMode = 'empty' | 'read'

/** Why the reader couldn't show the requested note — drives NotePage's state
 *  screen (#65). 'notFound' = no such note (404); 'unavailable' = engine down
 *  (503, retryable); 'generic' = anything else, message carried verbatim. */
export type NoteError = { kind: 'notFound' | 'unavailable' | 'generic'; message?: string }

export type NotesContextValue = {
  /** The folder skeleton + stats (GET /api/tree); null until the first load. */
  tree: Tree | null
  /** Whether the structure has loaded at least once (skeleton gate). */
  treeLoaded: boolean
  /** The skeleton nested for rendering (sidebar tree, Feed facet). */
  folderTree: SkeletonNode[]
  /** Existing folder paths, e.g. for the editor's folder picker. */
  folders: string[]
  /** Direct children of a folder ('' = project root), title-ordered — or null
   *  while that folder hasn't been loaded yet. */
  notesIn: (folder: string) => NoteView[] | null
  /** Kick the lazy load of a folder's direct listing (idempotent). */
  ensureFolder: (folder: string) => void
  /** The session's resolution cache: a note any listing/window has reported. */
  resolveKnown: (id: string) => NoteView | undefined
  /** Merge externally-fetched notes (Feed windows, graph nodes) into the
   *  resolution cache so navigate-first opens work from anywhere. */
  remember: (
    notes: readonly NoteView[],
    replaces?: readonly string[],
    observedAt?: number,
  ) => NoteView[]
  /** Notes seen this session — the wiki-link resolution pool (best-effort by
   *  design: an unseen target still opens via the server resolver). */
  knownNotes: NoteView[]
  /** Refresh the structure + ONLY the named folders that are loaded — the
   *  post-mutation narrow refresh (#94). A move/rename/delete touches a small,
   *  known set of folders; reloading EVERY loaded folder (~95 on a deep tree)
   *  saturated the browser's connection pool and stalled the next /api/move
   *  behind the wave. Collapsed/unloaded folders need no refetch (they reload
   *  on expand); the tree skeleton always refreshes for counts. */
  refreshFolders: (folders: readonly string[]) => Promise<void>
  /** Optimistically relocate a note between folders in the local caches (#94):
   *  the row moves instantly, latency-independent, so a slow /api/move never
   *  parks the note under the cursor inviting a conflicting re-drop. Returns the
   *  note's prior view (for rollback if the server rejects the move) or null if
   *  the note isn't in the resolution cache (caller falls back to a refresh). */
  applyLocalMove: (
    id: string,
    fromFolder: string,
    toFolder: string,
    newFilePath: string,
  ) => NoteView | null
  /** A note that JUST landed via an optimistic move — drives a brief highlight
   *  pulse on its new row (#94), then clears itself. */
  movedId: string | null
  /** Folder of a changed-event note-id (via the resolution cache): the "does
   *  this event touch my scope" filter consumers apply before refetching.
   *  null = the session can't place the id — treat as "may touch anything". */
  dirOfId: (id: string) => string | null
  nav: NavScope
  mode: ReaderMode
  note: NoteDetailView | null
  activeId: string | null
  /** Last note actually opened; survives clearing the reader (Feed, Home,
   *  graph) so "Files" can always return to it. */
  lastNote: NoteView | null
  loading: boolean
  /** A navigation to a DIFFERENT note is in flight (#68 item 3): the reader is
   *  loading a note whose id differs from the one `note` still holds (or there's
   *  no note yet — cold open). Content consumers (the main reader, the History
   *  aside) render a skeleton from this instead of the previous note's content,
   *  while the shell (breadcrumbs, topbar actions, the panel itself) keeps the
   *  old note so it doesn't collapse for a blink. An in-place reloadNote()
   *  doesn't set `loading`, so a post-mutation refresh never trips this. */
  navigating: boolean
  /** List/tree-load failure (boot 503, transport). The ONLY app-wide error
   *  channel left, owned by the list it belongs to and rendered where the list
   *  lives (the sidebar). Mutation failures go to toasts and note-open failures
   *  to `noteError`, so an error no longer rides across pages (#65). */
  listError: string | null
  /** The open note's failure, scoped to the reader. NotePage renders a styled
   *  state from it (not-found / engine-down / generic) — never a global banner,
   *  and a failed open no longer guts the previously-open note (#65 layer 3). */
  noteError: NoteError | null
  openNote: (id: string) => Promise<void>
  /** Re-fetch the open note (post-mutation: rename/move keep the id — and the
   *  URL — stable, so the reader refreshes in place instead of re-routing). */
  reloadNote: () => Promise<void>
  clearReader: () => void
}

export type NoteNavigationState = { preserveSpaceOnNoteOpen?: string }
