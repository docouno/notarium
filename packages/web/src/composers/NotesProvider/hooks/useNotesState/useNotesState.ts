import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { NOTE_CLASS } from '@notarium/contract/enums'
import { STORE_EVENT } from '@notarium/contract/events'
import { HTTP_STATUS } from '@notarium/contract/http'
import { SCAN_PHASE } from '@notarium/core'
import { effectiveSlug } from '@notarium/core/slug'
import { pushRecentNote } from '../../../../libs/recentNotes'
import { folderRoute, noteRouteForClass, parseAppPath } from '../../../../libs/routing/routePaths'
import { folderOf, nestFolders } from '../../../../libs/tree/tree'
import { canonicalFolderPath } from '../../../../libs/tree/tree'
import type { NoteDetailView, NoteView, Tree } from '../../../../libs/wire'
import { api } from '../../../../services/api'
import { useSpace } from '../../../SpaceProvider'
import { CHANGED_COALESCE_MS, useSync } from '../../../SyncProvider'
import { MOVED_PULSE_MS } from '../../consts'
import { classifyNoteError } from '../../helpers/classifyNoteError'
import { initialReaderState } from '../../helpers/initialReaderState'
import { asNote, asRecent } from '../../helpers/noteMappers'
import type {
  NavScope,
  NoteError,
  NoteNavigationState,
  NotesContextValue,
  ReaderMode,
} from '../../types'

export const useNotesState = (): NotesContextValue => {
  const location = useLocation()
  const navigate = useNavigate()
  const { space, personalSpace, reportNoteSpace } = useSpace()
  const { subscribe } = useSync()

  const [tree, setTree] = useState<Tree | null>(null)
  const [treeLoaded, setTreeLoaded] = useState(false)
  const [folderNotes, setFolderNotes] = useState<Map<string, NoteView[]>>(() => new Map())
  const [seen, setSeen] = useState<Map<string, NoteView>>(() => new Map())
  // Seed reader/scope from the URL synchronously so the first paint matches the
  // destination — no flash of the default state before the data lands (#65).
  const [boot] = useState(() => initialReaderState(window.location.pathname))
  const [nav, setNav] = useState<NavScope>(boot.nav)
  const [mode, setMode] = useState<ReaderMode>(boot.mode)
  const [note, setNote] = useState<NoteDetailView | null>(null)
  const [activeId, setActiveId] = useState<string | null>(boot.activeId)
  const [lastNote, setLastNote] = useState<NoteView | null>(null)
  const [loading, setLoading] = useState(boot.loading)
  const [listError, setListError] = useState<string | null>(null)
  const [noteError, setNoteError] = useState<NoteError | null>(null)
  // The note that just landed via an optimistic move — a transient pulse (#94).
  const [movedId, setMovedId] = useState<string | null>(null)
  const movedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Refs mirror the latest values for the location effect, which must fire on
  // navigation only — not re-subscribe on every data change.
  const seenRef = useRef(seen)
  const treeRef = useRef(tree)
  const folderNotesRef = useRef(folderNotes)
  const activeIdRef = useRef<string | null>(null)
  const noteRef = useRef<NoteDetailView | null>(null)
  const preserveSpaceOnNoteOpenRef = useRef<string | null>(null)
  const readyRef = useRef(false)
  const foldersInFlight = useRef(new Set<string>())
  // Whether the LAST tree load failed — the SSE status handler retries only
  // then, so a healthy structure isn't refetched on every lifecycle event.
  const treeFailedRef = useRef(false)
  // The space the in-memory caches belong to (#16). Responses that land after
  // a space switch are dropped — an out-of-order listing from the previous
  // space must never seed the new one's maps.
  const spaceRef = useRef(space)
  // Open-note sequencing (#68): a fast burst of file switches fires several
  // fetchNote calls; their responses can land out of order, and the OLDEST
  // (slowest) answer used to win and yank the reader back. A monotonic token
  // gates every state write so only the LATEST open applies, and an
  // AbortController cancels the superseded request so it stops costing network.
  const noteLoadSeq = useRef(0)
  const noteAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    seenRef.current = seen
  }, [seen])
  useEffect(() => {
    treeRef.current = tree
  }, [tree])
  useEffect(() => {
    folderNotesRef.current = folderNotes
  }, [folderNotes])
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])
  useEffect(() => {
    noteRef.current = note
  }, [note])
  useEffect(() => {
    const state = location.state as NoteNavigationState | null
    preserveSpaceOnNoteOpenRef.current =
      typeof state?.preserveSpaceOnNoteOpen === 'string' ? state.preserveSpaceOnNoteOpen : null
  }, [location.state])

  const folderTree = useMemo(() => (tree ? nestFolders(tree.folders) : []), [tree])
  const folders = useMemo(() => (tree ? tree.folders.map((f) => f.path) : []), [tree])
  const knownNotes = useMemo(() => [...seen.values()], [seen])

  const remember = useCallback((notes: readonly NoteView[]) => {
    if (!notes.length) {
      return
    }
    setSeen((prev) => {
      const next = new Map(prev)

      for (const n of notes) {
        if (n.id) {
          next.set(n.id, n)
        }
      }

      return next
    })
  }, [])

  const resolveKnown = useCallback((id: string) => seenRef.current.get(id), [])

  const loadTree = useCallback(async (): Promise<Tree | null> => {
    const forSpace = spaceRef.current

    try {
      const t = await api.treeGet(forSpace)

      if (spaceRef.current !== forSpace) {
        return null
      }
      setTree(t)
      setTreeLoaded(true)
      treeFailedRef.current = false
      setListError(null)
      return t
    } catch (e) {
      if (spaceRef.current !== forSpace) {
        return null
      }
      // An unreachable engine is a distinct, retryable state — name it instead
      // of dumping the transport error on the user.
      const err = e as { status?: number; message?: string }
      treeFailedRef.current = true
      setListError(
        err.status === HTTP_STATUS.SERVICE_UNAVAILABLE
          ? 'Knowledge engine is starting up — your notes are safe; the list loads automatically once it’s reachable.'
          : err.message || String(e),
      )
      return null
    }
  }, [])

  /** Fetch one folder's direct listing into the cache (and the seen registry).
   *  GET /api/tree/children IS the lazy tree's contract (#64) — title order
   *  and step semantics live server-side, /api/notes stays a pure listing.
   *  Per-folder sequencing: a refresh sweep may race an expand fetch of the
   *  same folder, and responses can land out of order — only the LATEST
   *  request's answer is applied, so a stale listing never overwrites a
   *  fresher one. */
  const folderLoadSeq = useRef(new Map<string, number>())
  const loadFolder = useCallback(
    async (folder: string): Promise<void> => {
      const forSpace = spaceRef.current
      const seq = (folderLoadSeq.current.get(folder) ?? 0) + 1
      folderLoadSeq.current.set(folder, seq)
      try {
        const step = await api.treeChildrenGet(forSpace, folder)

        if (spaceRef.current !== forSpace) {
          return
        } // a switch landed mid-flight
        if (folderLoadSeq.current.get(folder) !== seq) {
          return
        } // superseded mid-flight
        remember(step.notes)
        setFolderNotes((prev) => new Map(prev).set(folder, step.notes))
      } catch {
        // a folder listing that failed simply stays unloaded; expand retries it
        foldersInFlight.current.delete(folder)
      }
    },
    [remember],
  )

  const ensureFolder = useCallback(
    (folder: string) => {
      if (folderNotesRef.current.has(folder) || foldersInFlight.current.has(folder)) {
        return
      }
      foldersInFlight.current.add(folder)
      void loadFolder(folder).finally(() => foldersInFlight.current.delete(folder))
    },
    [loadFolder],
  )

  /** Folder of a changed-event note-id — via the resolution cache (the id
   *  carries no path). null = unknown id: the caller refreshes broadly. */
  const dirOfId = useCallback((id: string): string | null => {
    const known = seenRef.current.get(id)
    return known ? folderOf(known.filePath) : null
  }, [])

  /** Refresh the structure + the folder listings this session holds. `touched`
   *  (note-ids from a changed event) narrows the folder refetches; null — or
   *  any id the session can't place — means "refresh everything loaded". */
  const refreshData = useCallback(
    async (
      touched: ReadonlySet<string> | null = null,
      destFolders: ReadonlySet<string> | null = null,
    ) => {
      let dirs: Set<string> | null = null

      if (touched) {
        dirs = new Set()
        for (const id of touched) {
          const dir = dirOfId(id)

          if (dir === null) {
            dirs = null // an id we can't place — its folder may be any of them
            break
          }
          dirs.add(dir)
        }
      }
      // Union in the server-truth folders the event carried (#94): `dirs` holds
      // the OLD folders we resolved from our own cache; `folders` holds the NEW
      // ones the read-model reported. A move by ANOTHER client refreshes both —
      // the folder the note left AND the one it landed in — so it never lingers
      // in a stale place (or vanishes) on an observer. Null `dirs` stays broad.
      if (dirs && destFolders) {
        for (const f of destFolders) {
          dirs.add(f)
        }
      }
      const loaded = [...folderNotesRef.current.keys()]
      await Promise.all([
        loadTree(),
        ...loaded.filter((folder) => !dirs || dirs.has(folder)).map((folder) => loadFolder(folder)),
      ])
    },
    [loadTree, loadFolder, dirOfId],
  )

  /** Narrow post-mutation refresh (#94): reload the tree skeleton + only those
   *  of `folders` this session actually holds. Unloaded folders are skipped
   *  (they fetch lazily on expand), so a mutation costs a handful of requests,
   *  never the whole loaded set. */
  const refreshFolders = useCallback(
    async (paths: readonly string[]) => {
      const want = new Set(paths)
      const loaded = [...folderNotesRef.current.keys()].filter((f) => want.has(f))
      await Promise.all([loadTree(), ...loaded.map((f) => loadFolder(f))])
    },
    [loadTree, loadFolder],
  )

  /** Move a note between folders in the local caches, instantly (#94). Bumping
   *  each folder's load-seq is the duplicate fix: a listing fetch in flight from
   *  BEFORE this move (a concurrent refresh or scroll-driven load) carries stale
   *  membership — the note still in its old folder — and, landing afterwards,
   *  would resurrect it in two places; the bump makes loadFolder drop that
   *  superseded answer. The authoritative post-move refresh then refetches both
   *  folders fresh. Notes only — a folder move relocates a whole subtree, beyond
   *  a single-row edit, so it just takes the narrow refresh. */
  const applyLocalMove = useCallback(
    (id: string, fromFolder: string, toFolder: string, newFilePath: string): NoteView | null => {
      const prev = seenRef.current.get(id)

      if (!prev) {
        return null
      }
      const moved: NoteView = { ...prev, filePath: newFilePath }
      folderLoadSeq.current.set(fromFolder, (folderLoadSeq.current.get(fromFolder) ?? 0) + 1)
      folderLoadSeq.current.set(toFolder, (folderLoadSeq.current.get(toFolder) ?? 0) + 1)
      setFolderNotes((prevMap) => {
        const next = new Map(prevMap)
        const from = next.get(fromFolder)

        if (from) {
          next.set(
            fromFolder,
            from.filter((n) => n.id !== id),
          )
        }
        const to = next.get(toFolder)

        if (to) {
          // Title order mirrors the server's `sort=title` listing so the
          // optimistic row lands where the refetch will confirm it.
          const merged = to.filter((n) => n.id !== id)
          merged.push(moved)
          merged.sort((a, b) => (a.title || '').localeCompare(b.title || ''))
          next.set(toFolder, merged)
        }

        return next
      })
      setSeen((prevMap) => new Map(prevMap).set(id, moved))
      setMovedId(id)
      if (movedTimer.current) {
        clearTimeout(movedTimer.current)
      }
      movedTimer.current = setTimeout(() => setMovedId(null), MOVED_PULSE_MS)
      return prev
    },
    [],
  )

  useEffect(
    () => () => {
      if (movedTimer.current) {
        clearTimeout(movedTimer.current)
      }
    },
    [],
  )

  const clearReader = useCallback(() => {
    setNote(null)
    setActiveId(null)
    setMode('empty')
    setNoteError(null)
  }, [])

  // Fetch a note into the reader on NAVIGATION (open / deep-link). `id` is a
  // note-id (the URL's address) or anything the backend's resolver accepts (a
  // wiki-link title/path). Returns the loaded note, or null on failure — having
  // recorded `noteError` so NotePage renders a styled state. The previously-open
  // note IS dropped here: we navigated to this id (the URL moved), so back
  // returns naturally. An in-place refresh that must NOT blank the note on a
  // blip is reloadNote(), below.
  const fetchNote = useCallback(
    async (id: string): Promise<NoteDetailView | null> => {
      // Latest-wins (#68): claim a token and abort the prior open. Every state
      // write below is gated on this still being the newest call, so an
      // out-of-order or superseded answer can never touch the reader.
      const seq = ++noteLoadSeq.current
      noteAbort.current?.abort()
      const ac = new AbortController()
      noteAbort.current = ac
      const isCurrent = () => noteLoadSeq.current === seq
      setMode('read')
      setActiveId(id) // optimistic so the UI keeps the note while it loads
      setLoading(true)
      setNoteError(null)
      try {
        let n: NoteDetailView

        try {
          n = await api.noteGet(id, ac.signal)
        } catch (e) {
          if (ac.signal.aborted) {
            return null
          } // superseded mid-flight
          // Not a note-id → the wiki-resolver channel (#16): storage keys
          // (titles/paths) resolve WITHIN the active space only — reference
          // resolution never crosses the space boundary.
          if ((e as { status?: number }).status !== HTTP_STATUS.NOT_FOUND) {
            throw e
          }
          n = await api.noteResolve(spaceRef.current, id, ac.signal)
        }
        if (!isCurrent()) {
          return null
        } // a newer open landed first — drop this answer
        setNote(n)
        setActiveId(n.id || id)
        // A space-free note may land in another space than the chrome shows. User
        // docs adopt their real space; project memory does too. Personal memory
        // stays space-less in practice: it belongs to the Agents layer and must not
        // yank the workspace away from the project the user is auditing.
        const keepSourceSpace = preserveSpaceOnNoteOpenRef.current === spaceRef.current

        if (
          !keepSourceSpace &&
          n.space &&
          (n.class !== NOTE_CLASS.agentMemory || n.space !== personalSpace?.slug)
        ) {
          reportNoteSpace(n.space)
        }
        const prevKnown = seenRef.current.get(n.id || id) ?? seenRef.current.get(id)
        const known = asNote(n, prevKnown)
        const recent = asRecent(n, prevKnown)

        if (known) {
          setLastNote(known)
          remember([known])
          // The single open chokepoint (tree click, deep link, Spotlight all reach
          // here) — record the note in its space's recently-opened MRU, the
          // Spotlight's empty-state list (#31). Keyed by the note's REAL space (a
          // space-free /n/<id> may resolve elsewhere than the chrome shows).
          if (recent) {
            pushRecentNote(n.space ?? spaceRef.current, recent)
          }
        }
        // Opening a note moves the rail into its folder scope, so a stale 'feed'
        // (or 'all') scope stops lighting up while a file is open.
        setNav({ type: 'folder', folder: folderOf(n.filePath) })
        return n
      } catch (e) {
        if (ac.signal.aborted || !isCurrent()) {
          return null
        } // not this open's error to show
        setNote(null)
        setNoteError(classifyNoteError(e))
        return null
      } finally {
        if (isCurrent()) {
          setLoading(false)
        }
      }
    },
    [remember, reportNoteSpace, personalSpace?.slug],
  )

  // Imperative open. Navigate-first (#60): when the resolution cache knows the
  // note, the URL flips synchronously and the location effect fetches into the
  // reader (skeleton first, content when it lands) — a click is never parked
  // behind a slow fetch. The fetch-then-navigate path remains for references
  // the cache can't resolve (a wiki-link title never listed) — the backend is
  // the resolver there.
  const openNote = useCallback(
    async (id: string) => {
      const known = seenRef.current.get(id)

      if (known) {
        // Land straight on the canonical /n/<id>/<slug> (#100 phase 1) so there's no
        // bare-URL flash before NotePage's redirect.
        const path = noteRouteForClass(
          known.id,
          known.class,
          effectiveSlug(known.slug, known.title),
        )

        if (path && path !== window.location.pathname) {
          navigate(path) // the location effect takes it from here
          return
        }
        if (known.id !== activeIdRef.current) {
          await fetchNote(known.id)
        }

        return
      }
      const n = await fetchNote(id)
      // Resolved → its canonical id+slug URL; missed → still anchor the attempt to
      // /n/<id> so the not-found state has its own history entry (back returns to
      // where we came from instead of stranding the not-found view on the
      // previous note's URL — #65 layer 3).
      const path = n
        ? noteRouteForClass(n.id, n.class, effectiveSlug(n.slug, n.title || ''))
        : noteRouteForClass(id)

      if (path && path !== window.location.pathname) {
        navigate(path)
      }
    },
    [fetchNote, navigate],
  )

  // Re-fetch the open note IN PLACE (post-mutation: rename/move/save/restore keep
  // the id — and the URL — so the reader refreshes without re-routing). Unlike
  // fetchNote, a failure here keeps the note as the user last saw it: a transient
  // blip must not blank an open note (SSE 'changed' or the next action recovers).
  const reloadNote = useCallback(async () => {
    const id = activeIdRef.current

    if (!id) {
      return
    }
    try {
      const n = await api.noteGet(id)

      // A navigation may have moved the reader on while this in-place refresh
      // was in flight — don't let a stale reload clobber the newly-open note (#68).
      if (activeIdRef.current !== id) {
        return
      }
      setNote(n)
      setNoteError(null)
      const keepSourceSpace = preserveSpaceOnNoteOpenRef.current === spaceRef.current

      if (
        !keepSourceSpace &&
        n.space &&
        (n.class !== NOTE_CLASS.agentMemory || n.space !== personalSpace?.slug)
      ) {
        reportNoteSpace(n.space)
      }
      const known = asNote(n)

      if (known) {
        setLastNote(known)
        remember([known])
      }
      setNav({ type: 'folder', folder: folderOf(n.filePath) })
    } catch {
      // keep the current note; the refresh simply didn't land
    }
  }, [remember, reportNoteSpace, personalSpace?.slug])

  // Apply a location to the reader/scope state. `/n/<id>/…` and `/m/<id>/…` resolve by id
  // only (the slug is decorative); `/files/<path>` is always a folder browse —
  // notes have no URL in the files namespace (#51).
  const applyLocation = useCallback(
    async (pathname: string) => {
      const r = parseAppPath(pathname)

      if (r.kind === 'graph') {
        return
      } // graph keeps the reader state for "Files"
      // Settings / Agents / Trash surfaces are chrome-only; leave the note/nav state
      // untouched (the reader keeps its last note so "back" returns to it).
      if (
        r.kind === 'settings' ||
        r.kind === 'workspaceSettings' ||
        r.kind === 'agents' ||
        r.kind === 'trash'
      ) {
        return
      }
      if (r.kind === 'feed') {
        clearReader()
        setNav({ type: 'feed', folder: '' })
        return
      }
      // Dashboard deep surfaces (#216) browse like the home overview — no reader, no
      // folder scope; the rail keeps the home logo lit (nav.type 'all'), just like
      // the bare `/s/<space>`.
      if (r.kind === 'all' || r.kind === 'root' || r.kind === 'dashboard') {
        clearReader()
        setNav({ type: 'all', folder: '' })
        return
      }
      if (r.kind === 'files') {
        clearReader()
        setNav({ type: 'folder', folder: r.path })
        return
      }
      if (r.kind !== 'note' && r.kind !== 'memoryNote') {
        return
      }
      const known = seenRef.current.get(r.id)

      if (known) {
        setNav({ type: 'folder', folder: folderOf(known.filePath) })
        if (r.id !== activeIdRef.current) {
          void fetchNote(r.id)
        }

        return
      }
      if (noteRef.current?.id === r.id) {
        // openNote() just landed here with a note the cache didn't know yet
        // (e.g. resolved by title right after a save) — keep it open.
        setNav({ type: 'folder', folder: folderOf(noteRef.current.filePath) })
        return
      }
      // Deep link to a note this client never listed: the backend resolves the
      // id. A miss leaves the reader in fetchNote's noteError state so NotePage
      // shows the styled not-found / engine-down screen ON THIS URL — back works.
      await fetchNote(r.id)
    },
    [clearReader, fetchNote],
  )

  // Mount AND space switch (#16): the in-memory world (structure, listings,
  // resolution cache, folder sequencing) belongs to ONE space — drop it all,
  // then load the new space's structure and re-apply the location.
  useEffect(() => {
    spaceRef.current = space
    readyRef.current = false
    treeFailedRef.current = false
    folderLoadSeq.current = new Map()
    foldersInFlight.current.clear()
    setTree(null)
    setTreeLoaded(false)
    setFolderNotes(new Map())
    setSeen(new Map())
    // Tree (sidebar) and reader (the URL's target) are independent — boot them in
    // PARALLEL so the reader never waits on the tree. Serializing these was the
    // source of the boot flash: the home Splash showed for the WHOLE loadTree
    // before applyLocation flipped to the note (#65 no-flicker). readyRef flips
    // after the initial applyLocation so the location effect doesn't double-fire.
    void loadTree()
    void applyLocation(window.location.pathname).then(() => {
      readyRef.current = true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space])

  // Every navigation after boot (tree links, back/forward, programmatic).
  useEffect(() => {
    if (!readyRef.current) {
      return
    }
    void applyLocation(location.pathname)
  }, [location.pathname, applyLocation])

  // #100 phase 3: canonicalise an old (aliased) folder URL. A folder rename keeps its
  // id; the server's /tree carries past paths for moved identified folders/projects,
  // so a bookmark to `/files/<oldpath>` redirects to the current path — the folder
  // twin of the note's stale-slug redirect (NotePage). Re-runs when the tree loads
  // (a deep link can land before the skeleton, so we can't decide the redirect until then).
  useEffect(() => {
    const r = parseAppPath(location.pathname)

    if (r.kind !== 'files' || !r.path || !tree) {
      return
    }
    const current = canonicalFolderPath(r.path, tree.folders)

    if (current && current !== r.path) {
      navigate(folderRoute(r.space, current), { replace: true })
    }
  }, [location.pathname, tree, navigate])

  // Server-push (#60/#64): the structure lives on the shared SSE stream.
  //  - `changed` → coalesced refresh of the tree + the touched loaded folders;
  //  - `status` → retry a failed boot as soon as the read-model reports notes
  //    are available, and re-resolve the deep-linked URL the empty first pass
  //    couldn't (only while no note is open, so a retry never yanks state).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let touched: Set<string> | null = new Set()
    // The server-truth folders the coalesced events advertised (new locations) —
    // unioned with the old folders we resolve from our cache, so a relocation by
    // another client refreshes both endpoints (#94 multi-client sync).
    let destFolders = new Set<string>()
    const off = subscribe((event) => {
      if (event.type === STORE_EVENT.CHANGED) {
        if (!readyRef.current || treeFailedRef.current) {
          return
        }
        if (touched) {
          for (const id of [...event.upserts, ...event.removed]) {
            touched.add(id)
          }
        }
        for (const f of event.folders ?? []) {
          destFolders.add(f)
        } // ?? : tolerate an older server
        if (timer) {
          return
        }
        timer = setTimeout(() => {
          timer = null
          const ids = touched
          const dests = destFolders
          touched = new Set()
          destFolders = new Set()
          void refreshData(ids && ids.size ? ids : null, dests)
        }, CHANGED_COALESCE_MS)
        return
      }
      if (event.type !== STORE_EVENT.STATUS) {
        return
      } // 'graph' is the canvas's concern
      const phase = event.status.scan.phase

      if (!treeFailedRef.current || phase === SCAN_PHASE.cold || phase === SCAN_PHASE.error) {
        return
      }
      treeFailedRef.current = false // claim the retry; a failure sets it back
      void loadTree().then((t) => {
        if (t && !activeIdRef.current) {
          void applyLocation(window.location.pathname)
        }
      })
    })

    return () => {
      off()
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [subscribe, loadTree, refreshData, applyLocation])

  const value: NotesContextValue = {
    tree,
    treeLoaded,
    folderTree,
    folders,
    notesIn: useCallback((folder: string) => folderNotes.get(folder) ?? null, [folderNotes]),
    ensureFolder,
    resolveKnown,
    remember,
    knownNotes,
    refreshFolders,
    applyLocalMove,
    movedId,
    dirOfId,
    nav,
    mode,
    note,
    activeId,
    lastNote,
    loading,
    // A different note is loading: the reader is busy and what `note` holds (if
    // anything) is the PREVIOUS note, not the one the URL now points at.
    navigating: loading && (!note || note.id !== activeId),
    listError,
    noteError,
    openNote,
    reloadNote,
    clearReader,
  }

  return value
}
