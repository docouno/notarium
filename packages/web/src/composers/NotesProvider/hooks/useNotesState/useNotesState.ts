import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import type { NoteSort, SortDir } from '@notarium/contract'
import { NOTE_CLASS, NOTE_SORT, SORT_DIR } from '@notarium/contract/enums'
import { STORE_EVENT } from '@notarium/contract/events'
import { HTTP_STATUS } from '@notarium/contract/http'
import { comparatorFor, SCAN_PHASE } from '@notarium/core'
import { effectiveSlug } from '@notarium/core/slug'
import { pushRecentNote } from '../../../../libs/recentNotes'
import { folderRoute, noteRouteForClass, parseAppPath } from '../../../../libs/routing/routePaths'
import { STORAGE_KEYS } from '../../../../libs/storageKeys'
import { folderOf, nestFolders } from '../../../../libs/tree/tree'
import { canonicalFolderPath } from '../../../../libs/tree/tree'
import type { NoteDetailView, NoteView, Tree } from '../../../../libs/wire'
import { api } from '../../../../services/api'
import { useSpace } from '../../../SpaceProvider'
import { CHANGED_COALESCE_MS, useSync } from '../../../SyncProvider'
import { FOLDER_RETRY_DELAYS_MS, MOVED_PULSE_MS } from '../../consts'
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
import {
  beginHeldWindowReconciliation,
  isLatestRequest,
  markHeldWindowsReady,
  observeHeldWindowConnection,
} from './freshness'
import {
  isSeenObservationAccepted,
  rememberSeenNotes,
  removeSeenIds,
  replaceSeenFolder,
} from './seenRegistry'

type FolderLoadOutcome = 'settled' | 'failed' | 'invalidated'

/** A cold phase-1 id may be superseded by the durable frontmatter id while its
 *  read waits for boot. Only rewrite when the current route still addresses the
 *  request that produced this response; an unrelated A→B navigation must never
 *  be pulled back to the note whose response happened to finish. */
export const rekeyedNoteRoute = (
  pathname: string,
  requestedId: string,
  note: NoteDetailView,
): string | null => {
  if (!note.id || note.id === requestedId) {
    return null
  }
  const route = parseAppPath(pathname)

  if ((route.kind !== 'note' && route.kind !== 'memoryNote') || route.id !== requestedId) {
    return null
  }

  return noteRouteForClass(note.id, note.class, effectiveSlug(note.slug, note.title || ''))
}

export const useNotesState = (): NotesContextValue => {
  const location = useLocation()
  const navigate = useNavigate()
  const { space, personalSpace, reportNoteSpace } = useSpace()
  const { subscribe, connectionRevision, observationEpoch } = useSync()

  const [tree, setTree] = useState<Tree | null>(null)
  const [treeLoaded, setTreeLoaded] = useState(false)
  const [folderNotes, setFolderNotes] = useState<Map<string, NoteView[]>>(() => new Map())
  const [explorerSort, setExplorerSortState] = useState<NoteSort>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.explorerSort) as NoteSort | null
    return saved && Object.values(NOTE_SORT).includes(saved) ? saved : NOTE_SORT.title
  })
  const [explorerSortDir, setExplorerSortDirState] = useState<SortDir>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.explorerSortDir) as SortDir | null
    return saved && Object.values(SORT_DIR).includes(saved) ? saved : SORT_DIR.asc
  })
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

  // Refs expose the current cache values to async callbacks without making
  // those callbacks depend on render timing. `seen` and `folderNotes` are
  // committed through the helpers below: mirroring them back from an effect
  // would let an older render roll a newer async result back.
  const seenRef = useRef(seen)
  /** IDs removed by server truth, stamped with their observation epoch. A
   * response already in flight when the event landed must not put one back; a
   * later upsert or a post-reconnect snapshot may reconcile it. */
  const removedSeenIdsRef = useRef(new Map<string, number>())
  const treeRef = useRef(tree)
  const folderNotesRef = useRef(folderNotes)
  const explorerSortRef = useRef(explorerSort)
  const explorerSortDirRef = useRef(explorerSortDir)
  const activeIdRef = useRef<string | null>(null)
  const fetchNoteTaskRef = useRef<{
    id: string
    task: Promise<boolean>
  } | null>(null)
  const detailUpsertEpochRef = useRef(new Map<string, number>())
  const reloadNoteTaskRef = useRef<{ id: string; task: Promise<boolean> } | null>(null)
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
  // Invalidates folder responses and retry delays on every switch or unmount.
  const spaceGenerationRef = useRef(0)
  // Open-note sequencing (#68): a fast burst of file switches fires several
  // fetchNote calls; their responses can land out of order, and the OLDEST
  // (slowest) answer used to win and yank the reader back. A monotonic token
  // gates every state write so only the LATEST open applies, and an
  // AbortController cancels the superseded request so it stops costing network.
  const noteLoadSeq = useRef(0)
  const noteAbort = useRef<AbortController | null>(null)

  const commitSeen = useCallback((next: Map<string, NoteView>) => {
    seenRef.current = next
    setSeen(next)
  }, [])
  const commitFolderNotes = useCallback((next: Map<string, NoteView[]>) => {
    folderNotesRef.current = next
    setFolderNotes(next)
  }, [])

  useEffect(() => {
    treeRef.current = tree
  }, [tree])
  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])
  useEffect(() => {
    noteRef.current = note
  }, [note])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.explorerSort, explorerSort)
  }, [explorerSort])
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.explorerSortDir, explorerSortDir)
  }, [explorerSortDir])
  useEffect(() => {
    const state = location.state as NoteNavigationState | null
    preserveSpaceOnNoteOpenRef.current =
      typeof state?.preserveSpaceOnNoteOpen === 'string' ? state.preserveSpaceOnNoteOpen : null
  }, [location.state])

  const folderTree = useMemo(() => (tree ? nestFolders(tree.folders) : []), [tree])
  const folders = useMemo(() => (tree ? tree.folders.map((f) => f.path) : []), [tree])
  const knownNotes = useMemo(() => [...seen.values()], [seen])
  const folderLoadSeq = useRef(new Map<string, number>())
  const treeLoadSeq = useRef(0)
  const heldWindowReconciliationRef = useRef(beginHeldWindowReconciliation(0))
  const initializedSpaceRef = useRef(false)
  const spaceBootSeq = useRef(0)

  const remember = useCallback(
    (notes: readonly NoteView[], replaces: readonly string[] = [], observedAt?: number) => {
      if (!notes.length) {
        return []
      }
      const result = rememberSeenNotes(
        seenRef.current,
        notes,
        removedSeenIdsRef.current,
        replaces,
        observedAt ?? observationEpoch(),
      )

      commitSeen(result.seen)
      return result.accepted
    },
    [commitSeen, observationEpoch],
  )

  /** Removed stable ids are no longer locally conclusive wikilink targets. Keep
   *  the ref in lockstep with the state update so a click before the next React
   *  render cannot route around the authoritative server resolver. */
  const forget = useCallback(
    (ids: readonly string[]) => {
      if (!ids.length) {
        return
      }
      const removed = new Set(ids)

      const removalEpoch = observationEpoch()

      for (const id of removed) {
        removedSeenIdsRef.current.set(id, removalEpoch)
      }
      const nextSeen = removeSeenIds(seenRef.current, ids)
      const nextFolders = new Map(folderNotesRef.current)

      // A listing started before the event is older than this removal even if it
      // answers before the coalesced refresh starts. Supersede every outstanding
      // folder window so it cannot resurrect the deleted stable id.
      for (const [folder, seq] of folderLoadSeq.current) {
        folderLoadSeq.current.set(folder, seq + 1)
      }
      for (const [folder, notes] of nextFolders) {
        nextFolders.set(
          folder,
          notes.filter((row) => !removed.has(row.id)),
        )
      }
      commitSeen(nextSeen)
      commitFolderNotes(nextFolders)
    },
    [commitFolderNotes, commitSeen, observationEpoch],
  )

  const resolveKnown = useCallback((id: string) => seenRef.current.get(id), [])

  const loadTree = useCallback(async (): Promise<Tree | null> => {
    const forSpace = spaceRef.current
    const sequence = ++treeLoadSeq.current
    const request = { space: forSpace, sequence }
    const isCurrent = () =>
      isLatestRequest(request, { space: spaceRef.current, sequence: treeLoadSeq.current })

    try {
      const t = await api.treeGet(forSpace)

      if (!isCurrent()) {
        return null
      }
      setTree(t)
      setTreeLoaded(true)
      treeFailedRef.current = false
      setListError(null)
      return t
    } catch (e) {
      if (!isCurrent()) {
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

  /** Fetch a direct listing and publish only the current per-folder request.
   *  Distinguishes fetch failure from invalidation so a terminal stale response can start fresh.
   *  @see docs/drag-and-drop.md#2-the-tree-shows-folders-and-files-obsidian-style */
  const loadFolder = useCallback(
    async (folder: string): Promise<FolderLoadOutcome> => {
      const forSpace = spaceRef.current
      const forGeneration = spaceGenerationRef.current
      const observedAt = observationEpoch()
      const seq = (folderLoadSeq.current.get(folder) ?? 0) + 1
      folderLoadSeq.current.set(folder, seq)
      const supersededOutcome = (): FolderLoadOutcome | null => {
        if (spaceRef.current !== forSpace || spaceGenerationRef.current !== forGeneration) {
          return 'settled'
        } // a switch landed mid-flight
        if (folderLoadSeq.current.get(folder) !== seq) {
          // A loaded cache means another owner or an optimistic mutation supplied
          // usable data. An initial listing invalidated without data must be retried.
          return folderNotesRef.current.has(folder) ? 'settled' : 'invalidated'
        } // superseded mid-flight

        return null
      }

      try {
        const step = await api.treeChildrenGet(forSpace, folder, {
          sort: explorerSortRef.current,
          dir: explorerSortDirRef.current,
        })
        const superseded = supersededOutcome()

        if (superseded) {
          return superseded
        }
        const previous = folderNotesRef.current.get(folder) ?? []
        const observation = rememberSeenNotes(
          seenRef.current,
          step.notes,
          removedSeenIdsRef.current,
          [],
          observedAt,
        )

        const nextSeen = replaceSeenFolder(observation.seen, previous, observation.accepted)
        const nextFolders = new Map(folderNotesRef.current).set(folder, observation.accepted)

        // Refs move with the accepted authoritative response, before React's
        // render, so a same-tick wikilink click cannot use an id this empty
        // folder response just proved was deleted.
        commitSeen(nextSeen)
        commitFolderNotes(nextFolders)

        return 'settled'
      } catch {
        return supersededOutcome() ?? 'failed'
      }
    },
    [commitFolderNotes, commitSeen, observationEpoch],
  )

  /** Publish the new order from the held cache immediately, then reconcile the
   * same windows with server truth. Sequence bumps keep requests issued under
   * the previous order from overwriting this projection. */
  const applyExplorerOrder = useCallback(
    (sort: NoteSort, dir: SortDir) => {
      if (sort === explorerSortRef.current && dir === explorerSortDirRef.current) {
        return
      }
      explorerSortRef.current = sort
      explorerSortDirRef.current = dir
      setExplorerSortState(sort)
      setExplorerSortDirState(dir)

      for (const [folder, seq] of folderLoadSeq.current) {
        folderLoadSeq.current.set(folder, seq + 1)
      }
      const held = [...folderNotesRef.current.keys()]
      const next = new Map(folderNotesRef.current)

      for (const folder of held) {
        next.set(folder, [...(next.get(folder) ?? [])].sort(comparatorFor(sort, dir)))
      }
      commitFolderNotes(next)
      void Promise.all(held.map((folder) => loadFolder(folder)))
    },
    [commitFolderNotes, loadFolder],
  )

  const setExplorerSort = useCallback(
    (sort: NoteSort) => applyExplorerOrder(sort, explorerSortDirRef.current),
    [applyExplorerOrder],
  )
  const setExplorerSortDir = useCallback(
    (dir: SortDir) => applyExplorerOrder(explorerSortRef.current, dir),
    [applyExplorerOrder],
  )

  /** Pursue an initial folder listing with one in-flight owner for the whole chain.
   *  @see docs/drag-and-drop.md#2-the-tree-shows-folders-and-files-obsidian-style */
  const ensureFolder = useCallback(
    (folder: string) => {
      if (folderNotesRef.current.has(folder) || foldersInFlight.current.has(folder)) {
        return
      }
      const forSpace = spaceRef.current
      const forGeneration = spaceGenerationRef.current
      foldersInFlight.current.add(folder)

      const pursue = async () => {
        for (;;) {
          for (const delay of FOLDER_RETRY_DELAYS_MS) {
            if ((await loadFolder(folder)) === 'settled') {
              return
            }
            await new Promise((resolve) => setTimeout(resolve, delay))
            if (spaceRef.current !== forSpace || spaceGenerationRef.current !== forGeneration) {
              return
            }
          }
          if ((await loadFolder(folder)) !== 'invalidated') {
            return
          }
          if (spaceRef.current !== forSpace || spaceGenerationRef.current !== forGeneration) {
            return
          }
        }
      }

      void pursue().finally(() => {
        if (spaceRef.current === forSpace && spaceGenerationRef.current === forGeneration) {
          foldersInFlight.current.delete(folder)
        }
      })
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

  // The SSE endpoint does not replay frames missed before subscription or while
  // disconnected. Every successful open — INCLUDING the first — therefore
  // reloads every held authoritative window. Reader boot and stream open race;
  // the second one claims the revision so the first open reloads exactly once.
  useEffect(() => {
    const decision = observeHeldWindowConnection(
      heldWindowReconciliationRef.current,
      connectionRevision,
    )

    heldWindowReconciliationRef.current = decision.state
    if (decision.reload) {
      void refreshData()
    }
  }, [connectionRevision, refreshData])

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
      const nextFolders = new Map(folderNotesRef.current)
      const from = nextFolders.get(fromFolder)

      if (from) {
        nextFolders.set(
          fromFolder,
          from.filter((n) => n.id !== id),
        )
      }
      const to = nextFolders.get(toFolder)

      if (to) {
        const merged = to.filter((n) => n.id !== id)
        merged.push(moved)
        merged.sort(comparatorFor(explorerSortRef.current, explorerSortDirRef.current))
        nextFolders.set(toFolder, merged)
      }

      commitFolderNotes(nextFolders)
      commitSeen(new Map(seenRef.current).set(id, moved))
      setMovedId(id)
      if (movedTimer.current) {
        clearTimeout(movedTimer.current)
      }
      movedTimer.current = setTimeout(() => setMovedId(null), MOVED_PULSE_MS)
      return prev
    },
    [commitFolderNotes, commitSeen],
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
    detailUpsertEpochRef.current.clear()
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
      let settleTask!: (loaded: boolean) => void
      const settled = new Promise<boolean>((resolve) => {
        settleTask = resolve
      })
      let loaded = false

      fetchNoteTaskRef.current = { id, task: settled }
      const retainedEpoch = detailUpsertEpochRef.current.get(id) ?? 0

      detailUpsertEpochRef.current.clear()
      detailUpsertEpochRef.current.set(id, retainedEpoch)
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
        // A removal may land while detail I/O is in flight. One rejected live
        // answer is never published: repeat from the newer observation epoch so
        // the authoritative deleted detail (or a post-restore live detail) can
        // take over. A second rejection becomes an honest not-found state below,
        // never a blank reader or an endlessly-retried request.
        for (let attempt = 0; attempt < 2; attempt++) {
          const observedAt = observationEpoch()
          const upsertEpoch = detailUpsertEpochRef.current.get(id) ?? 0
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
          if ((detailUpsertEpochRef.current.get(id) ?? 0) !== upsertEpoch) {
            continue
          }
          const prevKnown = seenRef.current.get(n.id || id) ?? seenRef.current.get(id)
          const known = asNote(n, prevKnown)
          const admitted = isSeenObservationAccepted(
            n.id || id,
            n.deleted === true,
            removedSeenIdsRef.current,
            observedAt,
            observationEpoch(),
          )

          if (!admitted || (!n.deleted && !known)) {
            continue
          }
          // Cache admission is the same tombstone barrier as every list/window.
          // It runs BEFORE any reader, routing, MRU or space side effect.
          if (known && !remember([known], known.id !== id ? [id] : [], observedAt).length) {
            continue
          }
          const recent = asRecent(n, prevKnown)

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
            ((n.class !== NOTE_CLASS.agentMemory && n.class !== NOTE_CLASS.skill) ||
              n.space !== personalSpace?.slug)
          ) {
            reportNoteSpace(n.space)
          }
          if (known) {
            setLastNote(known)
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
          const rekeyedRoute = rekeyedNoteRoute(window.location.pathname, id, n)

          if (rekeyedRoute && rekeyedRoute !== window.location.pathname) {
            navigate(rekeyedRoute, { replace: true, state: location.state })
          }

          loaded = true
          return n
        }
        setNote(null)
        setNoteError({ kind: 'notFound' })
        return null
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
        settleTask(loaded)
        if (fetchNoteTaskRef.current?.task === settled) {
          fetchNoteTaskRef.current = null
        }
      }
    },
    [remember, reportNoteSpace, personalSpace?.slug, navigate, location.state, observationEpoch],
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
  // fetchNote, an ordinary transport failure keeps the last view. Once an
  // authoritative epoch rejects that view, however, a failed retry clears it
  // into the scoped error state instead of leaving known-stale live content.
  const reloadNote = useCallback((): Promise<boolean> => {
    const id = activeIdRef.current

    if (!id) {
      return Promise.resolve(false)
    }
    const opening = fetchNoteTaskRef.current

    if (opening?.id === id) {
      return opening.task
    }
    if (reloadNoteTaskRef.current?.id === id) {
      return reloadNoteTaskRef.current.task
    }
    const task = (async () => {
      let admissionRejected = false

      for (let attempt = 0; attempt < 2; attempt++) {
        const observedAt = observationEpoch()
        const upsertEpoch = detailUpsertEpochRef.current.get(id) ?? 0

        try {
          const n = await api.noteGet(id)

          // A navigation may have moved the reader on while this in-place refresh
          // was in flight — don't let a stale reload clobber the newly-open note (#68).
          if (activeIdRef.current !== id) {
            return false
          }
          if ((detailUpsertEpochRef.current.get(id) ?? 0) !== upsertEpoch) {
            continue
          }
          const known = asNote(n)
          const admitted = isSeenObservationAccepted(
            n.id || id,
            n.deleted === true,
            removedSeenIdsRef.current,
            observedAt,
            observationEpoch(),
          )

          if (!admitted || (!n.deleted && !known)) {
            admissionRejected = true
            continue
          }
          if (known && !remember([known], [], observedAt).length) {
            admissionRejected = true
            continue
          }
          const keepSourceSpace = preserveSpaceOnNoteOpenRef.current === spaceRef.current

          setNote(n)
          setNoteError(null)
          if (
            !keepSourceSpace &&
            n.space &&
            ((n.class !== NOTE_CLASS.agentMemory && n.class !== NOTE_CLASS.skill) ||
              n.space !== personalSpace?.slug)
          ) {
            reportNoteSpace(n.space)
          }
          if (known) {
            setLastNote(known)
          }

          setNav({ type: 'folder', folder: folderOf(n.filePath) })
          return true
        } catch (e) {
          if (admissionRejected && activeIdRef.current === id) {
            // We already know the displayed live snapshot is older than an
            // authoritative removal. A failed retry must not leave that stale
            // content on screen; show the scoped error with its normal Retry UI.
            setNote(null)
            setNoteError(classifyNoteError(e))
          }

          // An ordinary transient in-place refresh keeps the current note.
          return false
        }
      }
      if (admissionRejected && activeIdRef.current === id) {
        setNote(null)
        setNoteError({ kind: 'notFound' })
      }

      return false
    })()

    reloadNoteTaskRef.current = { id, task }
    void task.finally(() => {
      if (reloadNoteTaskRef.current?.task === task) {
        reloadNoteTaskRef.current = null
      }
    })
    return task
  }, [remember, reportNoteSpace, personalSpace?.slug, observationEpoch])

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
    const bootSequence = ++spaceBootSeq.current
    const generation = ++spaceGenerationRef.current
    // On the first mount revision zero is the snapshot/stream baseline, even if
    // the EventSource opened before this child effect ran. On a space switch the
    // currently-rendered revision belongs to the OLD space; wait for the new
    // stream's later revision instead of reconciling against the wrong socket.
    const baseline = initializedSpaceRef.current ? connectionRevision : 0

    initializedSpaceRef.current = true
    heldWindowReconciliationRef.current = observeHeldWindowConnection(
      beginHeldWindowReconciliation(baseline),
      connectionRevision,
    ).state
    spaceRef.current = space
    readyRef.current = false
    treeFailedRef.current = false
    folderLoadSeq.current = new Map()
    foldersInFlight.current.clear()
    setTree(null)
    setTreeLoaded(false)
    commitFolderNotes(new Map())
    removedSeenIdsRef.current.clear()
    detailUpsertEpochRef.current.clear()
    commitSeen(new Map())
    // Tree (sidebar) and reader (the URL's target) are independent — boot them in
    // PARALLEL so the reader never waits on the tree. Serializing these was the
    // source of the boot flash: the home Splash showed for the WHOLE loadTree
    // before applyLocation flipped to the note (#65 no-flicker). readyRef flips
    // after the initial applyLocation so the location effect doesn't double-fire.
    void loadTree()
    const finishBoot = () => {
      if (spaceBootSeq.current !== bootSequence || spaceRef.current !== space) {
        return
      }
      readyRef.current = true
      const decision = markHeldWindowsReady(heldWindowReconciliationRef.current)

      heldWindowReconciliationRef.current = decision.state
      if (decision.reload) {
        void refreshData()
      }
    }

    void applyLocation(window.location.pathname).then(finishBoot, finishBoot)
    return () => {
      if (spaceGenerationRef.current === generation) {
        spaceGenerationRef.current += 1
      }
    }
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
    let activeDetailTokens = new Map<string, string | undefined>()
    const off = subscribe((event) => {
      if (event.type === STORE_EVENT.CHANGED) {
        forget(event.removed)
        if (!readyRef.current || treeFailedRef.current) {
          return
        }
        if (touched) {
          for (const id of [...event.upserts, ...event.removed]) {
            touched.add(id)
          }
        }
        const active = activeIdRef.current

        if (active && event.upserts.includes(active)) {
          activeDetailTokens.set(active, noteRef.current?.versionToken)
          detailUpsertEpochRef.current.set(
            active,
            (detailUpsertEpochRef.current.get(active) ?? 0) + 1,
          )
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
          const detailTokens = activeDetailTokens
          touched = new Set()
          destFolders = new Set()
          activeDetailTokens = new Map()
          const activeAtFlush = activeIdRef.current
          const activeUpsertWasAlreadyRead =
            activeAtFlush != null &&
            detailTokens.has(activeAtFlush) &&
            noteRef.current?.versionToken !== detailTokens.get(activeAtFlush)
          const refreshActive =
            activeAtFlush != null && ids?.has(activeAtFlush) && !activeUpsertWasAlreadyRead
          void Promise.all([
            refreshData(ids && ids.size ? ids : null, dests),
            refreshActive ? reloadNote() : Promise.resolve(false),
          ])
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
  }, [subscribe, loadTree, refreshData, reloadNote, applyLocation, forget])

  const value: NotesContextValue = {
    tree,
    treeLoaded,
    folderTree,
    folders,
    notesIn: useCallback((folder: string) => folderNotes.get(folder) ?? null, [folderNotes]),
    explorerSort,
    explorerSortDir,
    setExplorerSort,
    setExplorerSortDir,
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
