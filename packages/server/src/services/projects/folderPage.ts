// The folder-page use-case: does a folder exist, and materializing its reserved
// `index.md` cover. Owned here, beside the folder-identity lifecycle a page mints,
// so the REST route and the MCP tool run ONE implementation instead of two.
// canon: docs/folder-page.md#page-materialization

import { NOTE_CLASS, PROJECT_STATUS } from '@notarium/contract'
import {
  FOLDER_PAGE_BASENAME,
  folderPageFilePath,
  isFolderPageOf,
  isPathUnder,
  type KnowledgeStore,
  normTags,
  type NoteMeta,
  READ_SCOPE,
  STORE_ERROR_REASON,
  type WriteInput,
} from '@notarium/core'

import type { FolderIdentityPersistence, ProjectsPersistence } from '../metaDb'
import { ALWAYS_LOAD_TAG, setNotePinned, type SpaceStore } from '../spaces'
import { ensureFolderIdentity } from './folderIdentity'
import type { MarkerStore } from './markerStore'

/** Does this space-relative folder exist? Truth is PHYSICAL, not a visibility
 *  question: the directory channel lists it, or some note lives under it. Read under
 *  `all` so the answer cannot depend on which classes the caller happens to see — the
 *  same reason the MCP container door already read it that way. For the paths these
 *  callers can address the two scopes agree by construction (every non-root mount is a
 *  dot-namespace and `safeRelAddress` refuses a leading dot), so this is a scope the
 *  predicate cannot drift on rather than a wider answer.
 *  `''` is the space root, which always exists. */
export const folderExists = async (store: KnowledgeStore, folderPath: string): Promise<boolean> => {
  if (folderPath === '') {
    return true
  }
  const [notes, dirs] = await Promise.all([
    store.list({ scope: READ_SCOPE.all }),
    store.listDirs ? store.listDirs() : Promise.resolve<string[]>([]),
  ])

  return dirs.includes(folderPath) || notes.some((note) => isPathUnder(note.filePath, folderPath))
}

/** The page a folder already has, if any — the one place that goes to the STORE to ask.
 *  Create refuses a second page on it, the REST route answers 409 from it, and a page
 *  move refuses to land on top of it; copies of one `filePath` comparison are how the
 *  folder EXISTENCE predicate drifted apart before it was pulled in here. The read
 *  surfaces answer the same question from the snapshot they already hold (`list_notes`,
 *  `start_session`) rather than paying for a second scan — so a change to the RULE
 *  belongs in `isFolderPageOf`, which all three of them call, not only here — with one
 *  deliberate exception: the create echo compares the path of the write IT just made,
 *  where the class is not in question because that same call hard-wired it. */
export const folderPageNoteOf = async (
  store: KnowledgeStore,
  folderPath: string,
): Promise<NoteMeta | undefined> => {
  const pageFile = folderPageFilePath(folderPath)

  // Asked through the strict predicate, not by path alone. In v1 the two answers cannot
  // differ — a default-scope read admits `user-doc` and `attachment`, and an attachment
  // is never a note row — so this is the cheap kind of defence: it costs nothing and it
  // keeps every place that asks "does this folder have a page" asking the same way.
  return (await store.list()).find(
    (note) => note.filePath === pageFile && isFolderPageOf(note.filePath, note.class),
  )
}

/** The authored note a page is materialized FROM. Title and body are already
 *  resolved by the caller's own contract (REST defaults `# <folder>`; MCP derives
 *  the title body-first and folds inline links in), so this operation owns the
 *  page LIFECYCLE, not the authoring rules. */
export type FolderPageAuthoredNote = Pick<
  WriteInput,
  'title' | 'content' | 'noteType' | 'tags' | 'fields' | 'fieldsUnquoted' | 'slug' | 'createdAt'
>

export type MaterializeFolderPageDeps = {
  store: SpaceStore
  projects: ProjectsPersistence
  folders: FolderIdentityPersistence
  /** Absent (the e2e fake) ⇒ registry-only, no marker file. */
  markerStore?: MarkerStore
  now: () => Date
  /** Journal attribution of the caller performing this write. */
  attribution?: Pick<WriteInput, 'principal' | 'agent'>
  /** Where a metadata step around the primary mutation is BEST-EFFORT, this reports its
   *  failure instead of failing the caller: the auto-pin after a create or a move, and
   *  the identity mint a page move runs from the move's `finalize`. It does not cover the
   *  mint inside `materializeFolderPage`, which is part of the create and fails it. */
  onPostPrimaryError?: (error: unknown) => void
}

export type MaterializeFolderPageResult =
  | { ok: true; folderId: string; noteId: string; versionToken: string; filePath?: string }
  /** The folder is gone (or never existed): no identity is minted for a ghost. */
  | { ok: false; reason: 'no-such-folder' }
  /** Someone already authored this page — a create never overwrites one. */
  | { ok: false; reason: 'page-exists' }

/** Author a folder's page: mint the folder's lazy identity, then write its reserved
 *  `index.md` as an ordinary `user-doc` note. This is the ONE implementation behind
 *  both the human REST route and the agent's `create_note(folderPage:true)`, so
 *  identity, collision, folder-race and active-project auto-pin cannot drift apart
 *  between the two doors.
 *  canon: docs/folder-page.md#page-materialization */
export const materializeFolderPage = async (
  deps: MaterializeFolderPageDeps,
  input: { space: string; folderPath: string; note: FolderPageAuthoredNote },
): Promise<MaterializeFolderPageResult> => {
  const { store, projects, folders, markerStore, now } = deps
  const { space, folderPath, note } = input

  if (!(await folderExists(store, folderPath))) {
    return { ok: false, reason: 'no-such-folder' }
  }
  if (await folderPageNoteOf(store, folderPath)) {
    return { ok: false, reason: 'page-exists' }
  }
  // The page of an ACTIVE project is that project's agent overview, so it carries the
  // ordinary always-load tag from its first save. Snapshot BEFORE the write; a project
  // that becomes active during it is reconciled post-primary below. The dedup below is by
  // the EXACT tag, which is how the PIN channel compares — it adds and removes this one
  // string. Tags elsewhere fold case for matching and faceting, so an author who writes a
  // differently-cased variant keeps it as their own tag and only the exact one pins.
  const activeAtSnapshot = (await projects.listForSpace(space)).some(
    (project) => project.path === folderPath && project.status === PROJECT_STATUS.active,
  )
  const authoredTags = normTags(note.tags) ?? []
  const tags = activeAtSnapshot
    ? [
        ...authoredTags.filter((tag, index) =>
          tag === ALWAYS_LOAD_TAG ? authoredTags.indexOf(tag) === index : true,
        ),
        ...(authoredTags.includes(ALWAYS_LOAD_TAG) ? [] : [ALWAYS_LOAD_TAG]),
      ]
    : note.tags
  let folderId = ''
  const folderMissing = new Error('folder disappeared before page creation')
  let written

  try {
    written = await store.write(
      {
        ...note,
        tags,
        directory: folderPath || undefined,
        // The reserved basename IS the page: never derived from the title.
        fileName: FOLDER_PAGE_BASENAME,
        // Hard-wired: a page is shared knowledge, never memory.
        // canon: docs/note-model.md#note-classes
        targetClass: NOTE_CLASS.userDoc,
        ...(deps.attribution ?? {}),
      },
      {
        // Identity/marker creation belongs to the page's path mutation: a concurrent
        // folder delete/move cannot clean a row this request has established, and a
        // registry failure cannot leave a written page behind a failed response.
        prepare: async () => {
          if (!(await folderExists(store, folderPath))) {
            throw folderMissing
          }
          folderId = await ensureFolderIdentity(
            { projects, folders, markerStore, now },
            { space, folderPath },
          )
        },
      },
    )
  } catch (error) {
    if (error === folderMissing) {
      return { ok: false, reason: 'no-such-folder' }
    }
    // Race backstop: two concurrent creates both snapshot a page-less folder; the
    // loser's write throws note_already_exists — the SAME answer as the pre-check.
    if ((error as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists) {
      return { ok: false, reason: 'page-exists' }
    }
    throw error
  }

  if (!activeAtSnapshot && written.id) {
    const activeAfterCreate = (await projects.listForSpace(space)).some(
      (project) => project.path === folderPath && project.status === PROJECT_STATUS.active,
    )

    if (activeAfterCreate) {
      await setNotePinned(store, written.id, true, deps.attribution?.principal).catch((error) => {
        try {
          deps.onPostPrimaryError?.(error)
        } catch {
          // The page is written; reporting a failed tag edit must not un-write it.
        }
      })
    }
  }

  return {
    ok: true,
    folderId,
    noteId: written.id ?? '',
    versionToken: written.versionToken ?? '',
    filePath: written.filePath,
  }
}

/** A page that ARRIVED at a folder instead of being written there — an explicit move
 *  re-homes an authored cover, which is the same condition that mints a folder's id on
 *  create. Adoption is two steps, and they belong to two different phases because the
 *  mutation fence says so:
 *
 *  1. `claimFolderIdentity` mints the destination's id INSIDE the move, passed as its
 *     `finalize` — after the move has landed, while the claim on the path is still held.
 *     Not `prepare`: a marker write is metadata ABOUT an existing folder and never
 *     provisions one, and the destination may not exist until this move creates it. The
 *     late hook also means a move that refuses leaves no row for a folder that never
 *     received the note, which is the whole point of staying inside the claim.
 *  2. `rehomeFolderPagePin` runs after the mutation. It rewrites the moved note's own
 *     tags, which cannot nest inside that note's mutation claim, and it applies the same
 *     rule the create door applies at its own transition.
 *
 *  Both swallow their own failures. A page with no folder identity is a LEGAL state — a
 *  plain `mv` on disk produces exactly it, and the read surface reports it honestly as a
 *  page without an id — so a registry hiccup must not fail a move the filesystem would
 *  have allowed. */
export const claimFolderIdentity = async (
  deps: MaterializeFolderPageDeps,
  input: { space: string; folderPath: string },
): Promise<void> => {
  const { projects, folders, markerStore, now } = deps

  try {
    await ensureFolderIdentity(
      { projects, folders, markerStore, now },
      { space: input.space, folderPath: input.folderPath },
    )
  } catch (error) {
    try {
      deps.onPostPrimaryError?.(error)
    } catch {
      // Reporting is best-effort too, and here that is load-bearing rather than
      // polite: this runs from the move's `finalize`, so anything thrown would skip
      // the change notification and fail a move that already landed on disk. The
      // folder-move route's own finalize double-wraps for the same reason.
    }
  }
}

/** The other half of the same lifecycle, decided ONCE for a page that changed folders.
 *  The tag says "this note is that project's overview", and a move can make that false as
 *  easily as true: leaving an active project's root drops it, entering one adds it. Both
 *  ends are read together on purpose: one registry read, one decision, and at most one
 *  write. Arrival wins — the source only decides when the page landed nowhere in
 *  particular — because a page that reaches an active project's root IS that project's
 *  overview, whatever the last one made of it. Deciding by whether the two ends differed
 *  reads as a saving and is not one: a tag write is already a no-op when the set does not
 *  change, so it bought nothing and cost a page that arrived still unpinned.
 *
 *  Best-effort, like the adoption it belongs to: the move already landed. */
export const rehomeFolderPagePin = async (
  deps: MaterializeFolderPageDeps,
  input: { space: string; from: string; to: string; noteId: string },
): Promise<void> => {
  const { store, projects } = deps

  try {
    const active = (await projects.listForSpace(input.space)).filter(
      (project) => project.status === PROJECT_STATUS.active,
    )
    const isRoot = (path: string) => active.some((project) => project.path === path)
    // Decided by where it ARRIVED, with the source only as the fallback: landing in an
    // active project's root makes it that project's overview whatever the last one
    // thought — the same reason `unmark → mark` re-pins a page a human had unpinned.
    // Comparing the two ends instead would leave a page that arrives at B still unpinned
    // because it happened to be unpinned in A, and B would show a cover whose body it
    // never loads. The write itself is a no-op when the tag set does not change, so a
    // pinned page moving between two active roots still costs nothing.
    const want = isRoot(input.to) ? true : isRoot(input.from) ? false : undefined

    if (want !== undefined) {
      await setNotePinned(store, input.noteId, want, deps.attribution?.principal)
    }
  } catch (error) {
    try {
      deps.onPostPrimaryError?.(error)
    } catch {
      // The move landed; a failure to report a failed tag edit must not undo that.
    }
  }
}
