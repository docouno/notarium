import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { ProjectRow } from '@notarium/contract'
import { AUTH_MODE } from '@notarium/contract/enums'
import { directoryOf } from '@notarium/core'
import { ContextMenu, type MenuItem } from '../../core/ContextMenu'
import { useDialog } from '../../core/Dialog'
import { EmptyState } from '../../core/EmptyState'
import {
  IconBot,
  IconBrain,
  IconCollapse,
  IconDoc,
  IconFolderKanban,
  IconFolderPlus,
  IconGraph,
  IconLayers,
  IconRefresh,
  IconSearch,
  IconStar,
  IconTrash,
  IconWorkspace,
} from '../../core/Icons'
import { useCopy, useToast } from '../../core/Toast'
import { canPinNote, noteFolderOf } from '../../libs/agentPin'
import { cx } from '../../libs/cx/cx'
import {
  canDropAnyInto,
  currentDragItems,
  DND_ATTRS,
  droppableInto,
  readDrag,
} from '../../libs/dnd/dnd'
import { errorText } from '../../libs/errors'
import { RAIL_PANEL, usePanelWidth } from '../../libs/hooks/usePanelWidth'
import {
  agentsRoute,
  feedRoute,
  folderPageHref,
  graphRoute,
  parseAppPath,
  spaceRoute,
  trashRoute,
} from '../../libs/routing/routePaths'
import type { ExplorerScope, SkeletonNode } from '../../libs/tree/tree'
import {
  carryOpenKeys,
  findSkeletonNode,
  isFilesSection,
  joinPath,
  outermostProjects,
  pushRecent,
  railScopeActive,
  scopeHidesFolder,
} from '../../libs/tree/tree'
import type { NoteView } from '../../libs/wire'
import { api } from '../../services/api'
import { SyncButton } from '../../widgets/SyncIndicator'
import { TreeState, type TreeStatus } from '../../widgets/TreeState'
import { useAuth } from '../AuthProvider'
import { useChrome } from '../ChromeProvider'
import { useEditing } from '../EditingProvider'
import { useFavorites } from '../FavoritesProvider'
import { captureDrop } from '../ImportDropZone/dropEntries'
import { useDropImport } from '../ImportDropZone/useFileImport'
import { useNotes } from '../NotesProvider'
import { useProjects } from '../ProjectsProvider'
import { useSpace } from '../SpaceProvider'
import { useSpotlight } from '../SpotlightProvider'
import { useSync } from '../SyncProvider'
import { useNoteActions } from '../useNoteActions'
import { RECENT_KEY, ROOT, SCOPE_KEY } from './consts'
import { dropFolderAt, isFileDrag } from './helpers/drop'
import { flattenTree } from './helpers/explorerRows'
import { favoriteBranchPaths, favoriteNoteFolders, favoriteTreeView } from './helpers/favoritesView'
import { dirOfPath, pathInside } from './helpers/paths'
import { loadRecent, loadScope } from './helpers/scopeStorage'
import { seedTopLevel } from './helpers/seedTopLevel'
import { useFolderExport } from './hooks/useFolderExport'
import { usePanelChrome } from './hooks/usePanelChrome'
import { useTreeSelection } from './hooks/useTreeSelection'
import { MemoryTree } from './MemoryTree'
import { NewButton } from './NewButton'
import { ProfileButton } from './ProfileButton'
import { ScopePicker } from './ScopePicker'
import { SettingsGear } from './SettingsGear'
import { SortButton } from './SortButton'
import { SpaceSwitcher } from './SpaceSwitcher'
import type { MenuState, Renaming, TreeApi } from './types'
import { VirtualTree } from './VirtualTree'
import styles from './Sidebar.module.scss'

export const Sidebar = () => {
  const { space, spaces, personalSpace, canWrite } = useSpace()
  const {
    folderTree,
    tree: structure,
    notesIn,
    explorerSort,
    explorerSortDir,
    setExplorerSort,
    setExplorerSortDir,
    ensureFolder,
    refreshFolders,
    treeLoaded,
    listError,
    nav,
    activeId,
    lastNote,
    openNote,
    knownNotes,
    movedId,
    navigating,
  } = useNotes()
  const spotlight = useSpotlight()
  const { status: syncStatus, changedLastMinute } = useSync()
  const { mode } = useAuth()
  const { railOpen, toggleRail } = useChrome()
  const { startNew } = useEditing()
  const {
    renameItem,
    removeNote,
    removeFolder,
    removeItems,
    createFolder,
    duplicateNote,
    moveItems,
  } = useNoteActions()
  const {
    projects,
    projectAt,
    canManage: canManageProjects,
    mark: markFolder,
    create: createProject,
    unmark: unmarkFolderById,
  } = useProjects()
  const favorites = useFavorites()
  const { confirm, prompt } = useDialog()
  const toast = useToast()
  // Drop OS files or a folder onto a folder row and import the captured source there.
  // Shared with the window content-zone dropzone so the import action exists once.
  const importDrop = useDropImport()
  const location = useLocation()
  const navigate = useNavigate()
  const route = parseAppPath(location.pathname)
  const onGraph = route.kind === 'graph'
  const agentsHome = route.kind === 'agents'
  const memoryNoteOpen = route.kind === 'memoryNote'
  // Graph, Settings and workspace-Management are chrome-only surfaces: the
  // reader isn't showing a note on them, so the rail must not keep one lit. The
  // route still RETAINS activeId (so "Files" can return to the last note), but
  // the rail's highlight is gated on actually being on a doc surface. Graph
  // already did this; Settings/Management were missed — going to Settings left
  // the previously-open note highlighted in the tree (#94).
  const onAgents = agentsHome || memoryNoteOpen
  const onTrash = route.kind === 'trash'
  const onChromePage =
    onGraph ||
    agentsHome ||
    onTrash ||
    route.kind === 'settings' ||
    route.kind === 'workspaceSettings'
  const browsing = !onChromePage
  // Are we on a face of the merged Files section (#245: feed / folder page / note)?
  // Shared by the rail highlight (railScopeActive) and pickScope (which lands you
  // on the section before applying a file-tree lens), so the two never disagree.
  const onFilesSection = isFilesSection({ browsing, memoryNoteOpen, navType: nav.type })
  const homeHref = spaceRoute(space)
  const feedHref = feedRoute(space)
  const graphHref = graphRoute(space)
  const trashHref = trashRoute(space)
  // The Agents surface (#13) is space-free — its href never carries the active
  // space (the personal domain is the user's, not a project's).
  const agentsHref = agentsRoute()

  // Width + horizontal resize, persisted; clamped to [200px, min(25vw, 520px)].
  // The vw cap mirrors the right aside's 45vw (neither panel may hog the window);
  // the 520px ceiling keeps the rail sane on ultra-wide monitors.
  const [width, startResize] = usePanelWidth(RAIL_PANEL)
  // Since #245 the merged "Files" section opens on its DEFAULT view — the feed
  // overview (the deliberate default) — so its rail link points at /feed: a plain click
  // lands on the overview, a middle-click opens it in a new tab. The last-read
  // note is still one click away (it stays revealed/lit in the tree); returning to
  // it is no longer the Files-icon's job.
  const filesHref = feedHref
  const [openSet, setOpenSet] = useState<Set<string>>(() => new Set())
  // The explorer view scope (#164): Files / Projects / a single project. Pure
  // CLIENT filter over the same server-authoritative skeleton + project registry.
  // Persisted per space (loadScope), so a focus survives a reload.
  const [scope, setScope] = useState<ExplorerScope>(() => loadScope(space))
  const scopeRef = useRef(scope)
  // On the Agents surface (#165) the explorer shows the agent-memory TREE instead
  // of the file tree — derived from the route, not persisted, so leaving Agents
  // restores the file scope. `scope` holds every file-side view (Files/Projects/
  // focus/Favorites, #42) and IS persisted, so opening a note keeps the rail on
  // its scope with no flicker; `effectiveScope` is what the panel renders + the
  // picker reflects (only Memory overrides it, because Memory is route-driven).
  const effectiveScope = useMemo<ExplorerScope>(
    () => (onAgents ? { kind: 'memory' } : scope),
    [onAgents, scope],
  )
  useEffect(() => {
    scopeRef.current = scope
  }, [scope])
  // Most-recently-focused project ids (#164) — the dropdown's quick-jumps.
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecent(space))
  // Apply + persist a tree lens, SILENTLY — set the scope and remember it, no
  // navigation. This is the form the AUTOMATIC scope corrections use (the invalid-
  // project fallback, the out-of-scope reveal): they must never yank the user's
  // surface. Memory (#165) is the one route-driven scope — picking it navigates to
  // the Agents surface; it is not persisted as a file scope. USER-initiated picks go
  // through `pickScope` below, which adds the land-on-the-section navigation.
  const chooseScope = useCallback(
    (next: ExplorerScope) => {
      if (next.kind === 'memory') {
        navigate(agentsHref)
        return
      }
      setScope(next)
      try {
        localStorage.setItem(SCOPE_KEY + space, JSON.stringify(next))
      } catch {
        /* storage blocked */
      }
    },
    [space, navigate, agentsHref],
  )
  // A USER-initiated lens pick (the rail star, the scope picker, focus-project). Set
  // the lens, then — if we're NOT already on a face of the merged Files section
  // (feed / folder / note) — land on the section's default view (the feed) so the
  // chosen lens's rail icon lights where you arrive (#245). On-section (reading a
  // note / on the feed) we do NOT navigate — the lens just re-filters the tree in
  // place (fork B: no yanking you off your note). This is what makes Files and
  // Favorites behave identically: pre-#245 picking a lens from Agents dropped you on
  // the DASHBOARD, where the star lit but Files couldn't. Crucially this navigation
  // lives ONLY here (a deliberate user act), NOT in chooseScope — so an automatic
  // fallback firing on the dashboard/graph never teleports the user to the feed.
  const pickScope = useCallback(
    (next: ExplorerScope) => {
      chooseScope(next)
      if (next.kind !== 'memory' && !onFilesSection) {
        navigate(feedHref)
      }
    },
    [chooseScope, onFilesSection, navigate, feedHref],
  )
  // Drop a sticky `favorites` scope (#42) back to the general Files tree. RAW
  // setScope (not chooseScope) for two reasons: it clears ONLY `favorites` — a
  // project focus is preserved — and it reads `scopeRef` so it needn't re-create on
  // every scope change. It is silent by construction (this is the effect/onClick
  // reset path, never a user pick, so it must not navigate).
  const clearFavoritesScope = useCallback(() => {
    if (scopeRef.current.kind !== 'favorites') {
      return
    }
    setScope({ kind: 'files' })
    try {
      localStorage.setItem(SCOPE_KEY + space, JSON.stringify({ kind: 'files' }))
    } catch {
      /* storage blocked */
    }
  }, [space])
  // Rail "Files" means "show me the general file tree": a plain left-click leaves
  // Favorites in the SAME frame it navigates, so the icon lights and the tree
  // switches together (Files is the target state — no intermediate flash). A middle/
  // ⌘-click keeps its native open-in-new-tab.
  const leaveFavoritesOnNav = useCallback(
    (e: ReactMouseEvent) => {
      if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        clearFavoritesScope()
      }
    },
    [clearFavoritesScope],
  )
  // Is this folder a marked project? The space root ('') is never a project here
  // (an auto-marked root must not collapse Projects into Files, #164).
  const isProjectFolder = useCallback((p: string) => p !== '' && Boolean(projectAt(p)), [projectAt])
  // Focus a project (from its context menu OR a dropdown quick-jump) and record it
  // in the per-space MRU (keyed by stable id, so a later rename/move doesn't drop
  // it). One path for both entry points so the recents stay honest.
  const focusProject = useCallback(
    (path: string) => {
      const p = projectAt(path)

      if (!p) {
        return
      }
      setRecentIds((prev) => {
        const next = pushRecent(prev, p.id)

        try {
          localStorage.setItem(RECENT_KEY + space, JSON.stringify(next))
        } catch {
          /* storage blocked */
        }

        return next
      })
      pickScope({ kind: 'project', path }) // user act → land on the section if off it
    },
    [projectAt, space, pickScope],
  )
  // Refs so the out-of-scope reset effect reacts to NOTE navigation (and the
  // projects-ready transition at boot) only — NOT to a scope/project-content
  // change, which would fight a deliberate focus. `projectsReady` flips false→true
  // exactly once (boot / space switch), so a stored focus on a deep-linked foreign
  // note is honoured the moment the registry lands; later mark/unmark keep it true.
  const isProjectRef = useRef(isProjectFolder)
  useEffect(() => {
    isProjectRef.current = isProjectFolder
  }, [isProjectFolder])
  const projectsReady = projects !== null
  // Has the projects list been (re)loaded for the CURRENT space? On a space switch
  // ProjectsProvider nulls `projects` then reloads; until we've seen that null→list
  // FOR THIS SPACE, the list may still be the previous space's, so the invalid-scope
  // reset below must not trust it (it'd wrongly drop a valid restored focus). Flips
  // false on space change, true only once `projects` becomes non-null again. (The
  // two setters run in declaration order before the reset effect on the same commit.)
  const projectsFreshRef = useRef(false)
  useEffect(() => {
    projectsFreshRef.current = false
  }, [space])
  useEffect(() => {
    if (projects !== null) {
      projectsFreshRef.current = true
    }
  }, [projects])
  // Auto-expand-once latch (#98 item 2): the first skeleton seeds the top level open,
  // then NEVER re-seeds — so "Collapse all" (which empties openSet) sticks instead
  // of the old `size===0` auto-expand snapping every folder back open. Reset on a
  // space switch so the new tree gets its own first-load expand.
  const seeded = useRef(false)
  // A tree refresh (#98 item 2) is in flight — spins the refresh glyph as honest
  // feedback (the reload is otherwise invisible on a warm tree).
  const [refreshing, setRefreshing] = useState(false)
  // Reveal-on-sync (#161): a monotonic nonce bumped by `refreshTree` to RE-ARM
  // VirtualTree's scroll latch. That latch scrolls to a note once per activeId
  // (so unrelated `rows` churn doesn't re-yank); a sync wants to re-scroll the
  // SAME already-active note (manual collapse → sync), which the latch alone
  // would skip — bumping this nonce clears it for one more pass.
  const [revealNonce, setRevealNonce] = useState(0)
  // Favorites reveal-once guard (used by the reveal effect below). Declared here so
  // the space-switch effect can reset it too: re-entering Favorites in a DIFFERENT
  // space must re-reveal its branches even if the two spaces' favorite signatures
  // happen to coincide (#42) — otherwise the sig-equal guard would skip the reveal.
  const revealedSigRef = useRef<string | null>(null)
  // A space switch (#16) swaps the whole tree — the previous space's expanded
  // paths are meaningless here and would suppress the first-load auto-expand. The
  // scope is space-scoped too, so reload it from this space's stored choice.
  useEffect(() => {
    setOpenSet(new Set())
    seeded.current = false
    setScope(loadScope(space))
    setRecentIds(loadRecent(space))
    revealedSigRef.current = null
  }, [space])
  const rootCount = treeLoaded ? (structure?.stats.root ?? 0) : 0

  // The displayed forest (#164), shaped by the scope: Files = the whole tree;
  // Projects = the outermost marked projects (nested ones stay in place); a single
  // project = re-rooted at its folder, showing only its contents; Favorites = the
  // same explorer filtered to favorited branches/notes. The top-level notes belong
  // to `rootFolder` (the project's path in focus, else the space root).
  // STRUCTURAL only — deliberately NOT dependent on `notesIn`, so a folder's lazy
  // note-load doesn't re-run outermostProjects/findSkeletonNode (those walk the whole
  // skeleton — wasteful per-load at 10k folders). The root notes are folded in at
  // `treeRows` instead, where `notesIn` belongs.
  const favoriteBranches = useMemo(() => favoriteBranchPaths(favorites.items), [favorites.items])
  const favoriteNotesByFolder = useMemo(
    () => favoriteNoteFolders(favorites.items, knownNotes, explorerSort, explorerSortDir),
    [favorites.items, knownNotes, explorerSort, explorerSortDir],
  )
  // A STABLE content signature of the favorites-reveal targets (branch paths + note
  // folders). The reveal effect keys off THIS, not the churning memo identities: a
  // background reload (#42) mints a fresh `favorites.items` array with the SAME
  // content, so favoriteBranches/favoriteNotesByFolder get new references every sync
  // — revealing on those would re-expand a folder the user just manually collapsed.
  const favoriteRevealSig = useMemo(
    () => [...favoriteBranches, ...favoriteNotesByFolder.keys()].sort().join('\n'),
    [favoriteBranches, favoriteNotesByFolder],
  )
  const view = useMemo(() => {
    if (effectiveScope.kind === 'favorites') {
      return favoriteTreeView(folderTree, rootCount, favoriteBranches, favoriteNotesByFolder)
    }
    if (effectiveScope.kind === 'projects') {
      return { roots: outermostProjects(folderTree, isProjectFolder), rootCount: 0, rootFolder: '' }
    }
    if (effectiveScope.kind === 'project') {
      const node = findSkeletonNode(folderTree, effectiveScope.path)

      if (node) {
        return { roots: node.children, rootCount: node.direct, rootFolder: effectiveScope.path }
      }
      // The focused project isn't in the skeleton (not loaded yet, or it vanished)
      // — fall back to Files to avoid an empty flash; the invalid-scope effect
      // resets the stored scope if it's truly gone.
    }

    return { roots: folderTree, rootCount, rootFolder: '' }
  }, [
    effectiveScope,
    folderTree,
    rootCount,
    isProjectFolder,
    favoriteBranches,
    favoriteNotesByFolder,
  ])
  // The scope's "root" folder — the drop/new-note target for the empty area.
  const scopeRoot = view.rootFolder
  const favoriteNotesIn = useCallback(
    (folder: string): NoteView[] | null => {
      if (favoriteBranches.some((path) => pathInside(folder, path))) {
        return notesIn(folder)
      }

      return [...(favoriteNotesByFolder.get(folder) ?? [])]
    },
    [favoriteBranches, favoriteNotesByFolder, notesIn],
  )
  const scopedNotesIn = effectiveScope.kind === 'favorites' ? favoriteNotesIn : notesIn
  const topLevelPaths = useMemo(() => folderTree.map((node) => node.path), [folderTree])
  // Child layout effects must never observe the first skeleton before its root
  // union: a folder-page reveal could otherwise settle against that shorter tree.
  const renderedOpenSet = useMemo(
    () =>
      seeded.current || topLevelPaths.length === 0 ? openSet : seedTopLevel(openSet, topLevelPaths),
    [openSet, topLevelPaths],
  )

  // Recently-focused projects for the dropdown (#164): resolve the MRU ids against
  // the live registry (dropping any that were unmarked/deleted, and the root), cap 5.
  const recentProjects = useMemo(() => {
    if (!projects) {
      return []
    }
    const byId = new Map(projects.map((p) => [p.id, p]))
    const out: ProjectRow[] = []

    for (const id of recentIds) {
      const p = byId.get(id)

      if (p && p.path !== '') {
        out.push(p)
      }
      if (out.length >= 5) {
        break
      }
    }

    return out
  }, [projects, recentIds])

  // Lazy listings (#64): kick the fetch for the scope's root level and every OPEN
  // folder that has direct notes — collapsed branches cost nothing, and the
  // provider keeps refreshing whatever was loaded over SSE.
  useEffect(() => {
    if (!treeLoaded) {
      return
    }
    if (view.rootCount > 0) {
      ensureFolder(view.rootFolder)
    }
    const walk = (nodes: readonly SkeletonNode[]) => {
      for (const node of nodes) {
        if (!renderedOpenSet.has(node.path)) {
          continue
        }
        if (node.direct > 0) {
          ensureFolder(node.path)
        }
        walk(node.children)
      }
    }
    walk(view.roots)
  }, [treeLoaded, view, renderedOpenSet, ensureFolder])

  // Favorites is still the explorer, just filtered: reveal the chains that make
  // favorited leaves/folders visible when ENTERING the scope or when the favorite
  // SET changes. A later manual collapse is respected: the reveal fires once per
  // (scope-entry, favorite-set-signature) — tracked by `revealedSigRef` — so a
  // background reload with unchanged favorites (new array, same content) does NOT
  // re-expand a folder the user just collapsed (#42). Leaving Favorites (or a
  // space switch, above) resets the ref, so re-entering re-reveals.
  useEffect(() => {
    if (effectiveScope.kind !== 'favorites') {
      revealedSigRef.current = null
      return
    }
    if (favorites.loading || favorites.error) {
      return
    }
    if (revealedSigRef.current === favoriteRevealSig) {
      return
    }
    revealedSigRef.current = favoriteRevealSig
    const toOpen = new Set<string>()

    const addAncestors = (path: string, includeSelf: boolean) => {
      const parts = path.split('/').filter(Boolean)
      const limit = includeSelf ? parts.length : Math.max(0, parts.length - 1)
      let acc = ''

      for (const part of parts.slice(0, limit)) {
        acc = acc ? `${acc}/${part}` : part
        toOpen.add(acc)
      }
    }

    for (const path of favoriteBranches) {
      addAncestors(path, false)
    }
    for (const folder of favoriteNotesByFolder.keys()) {
      addAncestors(folder, true)
    }
    if (!toOpen.size) {
      return
    }
    setOpenSet((prev) => {
      let changed = false
      const next = new Set(prev)

      for (const path of toOpen) {
        if (!next.has(path)) {
          next.add(path)
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [
    effectiveScope.kind,
    favorites.loading,
    favorites.error,
    favoriteRevealSig,
    favoriteBranches,
    favoriteNotesByFolder,
  ])

  // A focused project that no longer exists (unmarked, deleted, or absent in this
  // space after a switch) → fall back to Files (and persist it). Guarded on the
  // projects list being loaded AND fresh for this space, so neither a transient
  // null during reload nor the previous space's stale list (mid-switch) wrongly
  // drops a valid restored focus.
  useEffect(() => {
    if (scope.kind !== 'project' || projects === null || !projectsFreshRef.current) {
      return
    }
    if (!projects.some((p) => p.path === scope.path && p.path !== '')) {
      chooseScope({ kind: 'files' })
    }
  }, [scope, projects, chooseScope])

  const {
    dnd,
    clearSelection,
    sectionClick,
    treeRowsRef,
    dropTarget,
    setDropTarget,
    setDraggingKeys,
  } = useTreeSelection(space)

  // Right-click context menu + inline rename. `menu` holds the open popover
  // (coords + items + which row to highlight); `renaming` marks the item being
  // edited in place. Both are shared down into the tree rows via `treeApi`.
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<Renaming | null>(null)

  const copyText = useCopy()

  // Mark/unmark a folder as a project (#13) — the human management act, also
  // reachable from the space-management Projects tab. The confirm doubles as the
  // explainer the right-click menu lacks (Management has its section copy). The
  // provider's reload repaints the badge + keeps the management list in sync.
  const doMarkFolder = async (node: SkeletonNode) => {
    setMenu(null)
    const ok = await confirm({
      title: `Mark “${node.name}” as a project?`,
      message:
        'Agents can address this folder by its handle and scope what they remember and recall to it. The folder and its notes are untouched — you can unmark it any time.',
      confirmLabel: 'Mark as project',
    })

    if (!ok) {
      return
    }
    try {
      await markFolder(node.path, node.name)
      toast.success(`“${node.name}” is now a project`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const doUnmarkFolder = async (project: ProjectRow) => {
    setMenu(null)
    const ok = await confirm({
      title: `Unmark “${project.displayName}”?`,
      message:
        'Removes the project handle and its marker. The folder and its notes stay; agents can no longer address it as a project.',
      confirmLabel: 'Unmark',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      await unmarkFolderById(project.id)
      toast.success('Project unmarked')
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const { doExportFolder } = useFolderExport(space, () => setMenu(null))

  // Create a NEW empty project (#13 C): name → fresh marked folder. It appears in
  // the tree as an empty briefcase folder (the server's directory channel surfaces
  // it, #97), so reveal its ancestors and leave it for the user to fill. A name
  // clashing with an existing folder 409s — surfaced as a toast, name re-prompted.
  const doNewProject = async () => {
    setMenu(null)
    const name = await prompt({
      title: 'New project',
      message:
        'A project is a folder agents can address by handle and scope what they remember and recall to it. It starts empty — add notes whenever you like.',
      placeholder: 'e.g. Roadmap',
      confirmLabel: 'Create project',
    })

    if (!name?.trim()) {
      return
    }
    try {
      const row = await createProject(name)
      // The tree is server-authoritative (#97): the new (empty) folder shows once
      // the skeleton refreshes — createProject only reloaded the project badges.
      await refreshFolders([row.path.split('/').slice(0, -1).join('/')])
      revealAncestors(row.path)
      toast.success(`“${row.displayName}” is now a project`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  // Create a NEW empty (unmarked) folder (#97). A durable, first-class dir — fill
  // it whenever, or mark it a project later. A name clash 409s (toast). Slashes
  // nest. The tree is server-authoritative, so refresh the skeleton to show it.
  const doNewFolder = async (parent: string) => {
    setMenu(null)
    const name = await prompt({
      title: 'New folder',
      message:
        'A plain folder to organise notes. You can add notes to it any time, or mark it as a project later.',
      placeholder: 'e.g. Drafts',
      confirmLabel: 'Create folder',
    })
    const trimmed = name?.trim()

    if (!trimmed) {
      return
    }
    const path = parent ? `${parent}/${trimmed}` : trimmed

    try {
      await createFolder(path)
      revealAncestors(path)
      if (parent) {
        setOpenSet((prev) => new Set(prev).add(parent))
      }
      toast.success(`Folder “${trimmed}” created`)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  // Reveal a (possibly nested) folder's ancestors so a freshly created node is
  // visible right away.
  const revealAncestors = (path: string) => {
    setOpenSet((prev) => {
      const next = new Set(prev)
      let acc = ''

      for (const part of path.split('/').filter(Boolean).slice(0, -1)) {
        acc = acc ? `${acc}/${part}` : part
        next.add(acc)
      }

      return next
    })
  }

  // Carry a folder's expanded state across a rename/move (its path changes, and a
  // folder's path is its openSet identity). carryOpenKeys keeps the old keys too,
  // so nothing collapses during the server round-trip and a failed move leaves the
  // prior expansion intact; the reconcile effect sweeps the stale keys after.
  const carryOpenAcross = (oldPath: string, newPath: string) => {
    setOpenSet((prev) => carryOpenKeys(prev, oldPath, newPath))
  }

  const treeApi: TreeApi = {
    renaming,
    menuTarget: menu?.targetId ?? null,
    openMenu: (e, items, targetId) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY, items, targetId })
    },
    startRename: (kind, id) => {
      setMenu(null)
      setRenaming({ kind, id })
    },
    commitRename: (kind, item, value) => {
      setRenaming(null)
      const next = (value || '').trim()
      const cur = 'title' in item ? item.title : item.name

      if (!next || next === cur) {
        return
      }
      // A folder rename relocates its path — carry its (and its descendants')
      // expanded state across so it doesn't snap shut when the new skeleton lands.
      if (kind === 'folder') {
        const oldPath = (item as SkeletonNode).path
        carryOpenAcross(oldPath, joinPath(dirOfPath(oldPath), next))
      }
      renameItem(kind, item, next)
    },
    cancelRename: () => setRenaming(null),
    onNewInFolder: (folder) => void startNew(folder),
    onNewFolder: (parent) => void doNewFolder(parent),
    onDuplicate: duplicateNote,
    onDeleteNote: (target) =>
      void removeNote(target).then((deleted) => {
        if (deleted) {
          clearSelection()
        }
      }),
    onDeleteFolder: (target) =>
      void removeFolder(target).then((deleted) => {
        if (deleted) {
          clearSelection()
        }
      }),
    onDeleteItems: (items) =>
      void removeItems(items).then((deleted) => {
        if (deleted) {
          clearSelection()
        }
      }),
    copyText,
    projectAt,
    canManageProjects,
    onMarkFolder: (node) => void doMarkFolder(node),
    onUnmarkFolder: (project) => void doUnmarkFolder(project),
    isNoteFavorite: (id) => favorites.isNoteFavorite(id),
    isProjectFavorite: (id) => favorites.isProjectFavorite(id),
    folderFavorite: (path) => Boolean(favorites.folderFavorite(path)),
    onToggleNoteFavorite: (note) => {
      void favorites.toggleNote(note).catch((err) => toast.error(errorText(err)))
    },
    onToggleFolderFavorite: (node) => {
      void favorites.toggleFolder(node).catch((err) => toast.error(errorText(err)))
    },
    onToggleProjectFavorite: (project) => {
      void favorites.toggleProject(project).catch((err) => toast.error(errorText(err)))
    },
    onFocusProject: (path) => focusProject(path),
    onOpenFolderPage: (node) => navigate(folderPageHref(space, node)),
    folderPageHref: (node) => folderPageHref(space, node),
    canPin: (note) =>
      canWrite &&
      canPinNote({
        noteSpace: space,
        noteFolder: noteFolderOf(note.filePath),
        personalSlug: personalSpace?.slug ?? null,
        projects,
      }),
    onPinNote: (note) => {
      setMenu(null)
      void api
        .notePin(note.id, true)
        .then(() => toast.success('Pinned — the agent will always load this.'))
        .catch(() => toast.error('Couldn’t pin to agent context.'))
    },
    onExportFolder: (node) => void doExportFolder(node),
    canWrite,
  }

  const toggle = (path: string) => {
    setOpenSet((prev) => {
      const next = new Set(prev)

      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return next
    })
  }

  // Collapse all (#98 item 2): fold every open folder. The `seeded` latch (above)
  // keeps the auto-expand from immediately re-opening them.
  const collapseAll = () => setOpenSet(new Set())

  // Refresh (#98 item 2): reload the tree skeleton + every loaded folder currently
  // open. refreshFolders always reloads the skeleton and refetches the named
  // folders it actually holds, so the open set + root is exactly "the visible
  // listings" — collapsed/unloaded folders cost nothing (they reload on expand).
  const refreshTree = async () => {
    if (refreshing) {
      return
    }
    setRefreshing(true)
    try {
      await refreshFolders(['', scopeRoot, ...openSet])
      // Reveal-on-sync (#161, VS Code "reveal active file"): once the refreshed
      // data lands, expand the active note's ancestor folders and re-arm the
      // scroll so the tree lands on it — even when it's the SAME note already
      // active (a manual collapse + sync), which the per-note scroll latch in
      // VirtualTree would otherwise skip. `revealAncestors` only ADDS to openSet;
      // the scroll fires once the note's row reappears after the lazy listings
      // load (we lean on the existing async-aware scroll effect, not a fragile
      // rAF). Gated on a note actually open in the reader (`noteOpen` ⇒ a doc
      // surface — chrome pages keep `activeId` only to return to Files, and their
      // tree highlight is already null) with its detail landed
      // (`lastNote.id === activeId`), so agent-memory / mid-navigation never
      // mis-target. NAVIGATING to an out-of-scope note already bounced to Files
      // (#164 Q3); a deliberately-focused project with a foreign note open is the
      // exception — there any ancestor keys outside the focus just don't render
      // (inert), so the visible reveal is still scoped.
      if (noteOpen && lastNote && lastNote.id === activeId) {
        revealAncestors(lastNote.filePath)
        setRevealNonce((n) => n + 1)
      }
    } finally {
      setRefreshing(false)
    }
  }

  // The WHOLE folders section is one drop surface (#94 fast-drop fix): rows
  // bubble their drag events here and declare their target via data-drop-folder,
  // so the precise folder is read from whatever row is under the pointer (''=the
  // empty area below = root). We always preventDefault so a fast release never
  // slips through a between-dragover gap; validity governs only the highlight and
  // whether the drop does anything — dropping a note back into its own folder is
  // a silent no-op with no highlight (it must not light the root, §6).
  // The drop target of the row under the pointer, remapped so the empty area
  // resolves to the SCOPE's root (the focused project in single-project view,
  // else the space root) rather than always the space root.
  const dropTargetAt = (e: ReactDragEvent): string => dropFolderAt(e) || scopeRoot

  const sectionDragOver = (e: ReactDragEvent) => {
    // External file drag (#223): light the exact target folder row with the SAME
    // highlight as a move — every folder is a valid import target (no self/descendant
    // rules), so the mark is just the folder (root → the section wash).
    if (isFileDrag(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = canWrite ? 'copy' : 'none'
      if (canWrite) {
        const target = dropTargetAt(e)
        const mark = target === scopeRoot ? ROOT : target

        if (dropTarget !== mark) {
          setDropTarget(mark)
        }
      }

      return
    }
    const items = currentDragItems()

    if (!items.length) {
      return
    }
    const target = dropTargetAt(e)
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Validity is the pure folder/no-op rules in EVERY scope (#164): nesting a
    // project under another is legal (the model supports it, nearest-ancestor
    // wins) and the Projects view shows it in place — so there's no project-
    // specific ban; illegal cases (self / current parent / descendant) are
    // already barred by canDropInto. For a multi-select set (#163) the target
    // lights if AT LEAST ONE item would move there — the no-op/illegal members of
    // a mixed set are simply skipped on drop.
    const ok = canDropAnyInto(items, target)
    const mark = !ok ? null : target === scopeRoot ? ROOT : target

    if (dropTarget !== mark) {
      setDropTarget(mark)
    }
  }

  const sectionDragLeave = (e: ReactDragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
      return
    }
    setDropTarget(null)
  }

  const sectionDrop = (e: ReactDragEvent) => {
    // External file drag: snapshot it synchronously, then import into the target folder.
    if (isFileDrag(e)) {
      e.preventDefault()
      const target = dropTargetAt(e)
      setDropTarget(null)
      if (canWrite) {
        const capture = captureDrop(e.dataTransfer)

        void importDrop(capture, target)
      }

      return
    }
    e.preventDefault()
    if (!canWrite) {
      return
    } // readers can't move (rows aren't draggable either)
    const items = readDrag(e)
    const target = dropTargetAt(e)
    setDropTarget(null)
    // Clear the source dim HERE, not only on the native dragend: an optimistic
    // move (#94) relocates the dragged row's DOM on this very drop, BEFORE
    // dragend, and a relocated source can swallow its dragend — leaving the row
    // stuck dimmed (`.dragging`, opacity .4) and masking the `.just-moved` flash.
    // Clearing before the move means the row re-renders un-dimmed and the
    // landing highlight shows clean.
    setDraggingKeys(new Set())
    // Drop only the movable members of the set (the rest are no-ops/illegal, §6).
    const movable = droppableInto(items, target)

    if (!movable.length) {
      return
    }
    // Moving a folder relocates its path too — carry its expanded state across
    // (same identity-by-path issue as a rename) so a dragged-open folder stays
    // open under its new parent instead of collapsing when the skeleton lands.
    for (const it of movable) {
      if (it.kind === 'folder') {
        const base = it.id.split('/').pop() as string
        carryOpenAcross(it.id, joinPath(target, base))
      }
    }
    void moveItems(movable, target)
    clearSelection() // the set has moved — drop the (now-stale) selection
  }

  // Right-click on the empty tree area → create at the scope's root (the focused
  // project in single-project view, else the space root). Folder/note rows
  // stopPropagation in their own context-menu handlers, so this only fires for
  // genuinely empty space.
  const rootContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault()
    if (!canWrite) {
      return
    } // every root action is a create — nothing to offer a reader
    setMenu({
      x: e.clientX,
      y: e.clientY,
      targetId: null,
      items: [
        { label: 'New note', icon: <IconDoc size={14} />, onClick: () => void startNew(scopeRoot) },
        {
          label: 'New folder',
          icon: <IconFolderPlus size={14} />,
          onClick: () => void doNewFolder(scopeRoot),
        },
        ...(canManageProjects
          ? [
              {
                label: 'New project',
                icon: <IconFolderKanban size={14} />,
                onClick: () => void doNewProject(),
              } as MenuItem,
            ]
          : []),
      ],
    })
  }

  const { railScrollRef, panelHeadRef, panelHeadH } = usePanelChrome()
  // The tree skeleton is SERVER-AUTHORITATIVE (#97): the /tree endpoint already
  // unions the directory channel (empty projects, "New folder"s, emptied folders)
  // into the folder list, so the client no longer synthesises project folders —
  // ONE channel, which is what killed the dup-on-rename race (#13/item 2). `projects`
  // still drives the badges (projectAt), not the tree shape. The displayed forest
  // is the scope's `view` (#164) — Files = the whole tree, Projects/focus = a
  // filtered/re-rooted slice over the same skeleton.
  const treeRows = useMemo(
    () =>
      flattenTree(
        view.roots,
        view.rootCount > 0 ? scopedNotesIn(view.rootFolder) : null,
        view.rootCount,
        renderedOpenSet,
        scopedNotesIn,
        view.rootFolder,
      ),
    [view, scopedNotesIn, renderedOpenSet],
  )
  // Expose the current rows to the click-time shift-range (onSelect reads this
  // ref rather than depending on treeRows).
  treeRowsRef.current = treeRows

  const noteOpen = browsing && !memoryNoteOpen && !!activeId
  // Files and Favorites are the two EXPLORER-lens rail icons (#42/#245): the rail
  // lights exactly ONE of them, and ONLY while a face of the merged Files section is
  // the subject (feed / folder page / note) — never on the home dashboard (the logo
  // owns home), a memory note (/m, the Agents surface), or a chrome surface. Since
  // #245 the Feed is the section's DEFAULT sub-view (no separate rail icon), so
  // `nav.type === 'feed'` no longer means "not explorer"; the highlight is derived
  // from the explicit `isFilesSection` signal by railScopeActive (a pure, matrix-
  // tested helper). Which of the two lights is the tree LENS: Favorites owns it when
  // its lens is on, else Files (files / projects / single-project). Picking any lens
  // off-section first lands you on the section (pickScope → feed), so the chosen
  // icon always lights where you land — Files and Favorites behave identically.
  const { filesActive, favoritesActive } = railScopeActive({
    browsing,
    memoryNoteOpen,
    navType: nav.type,
    scopeKind: effectiveScope.kind,
  })
  // On a chrome-only surface (graph/settings/management) the reader isn't
  // showing a note, so the tree must not mark one active — `activeId` is
  // retained only to restore it on return to Files. Gate the tree highlight on
  // doc view. (Search is also doc view, so a matching open note still
  // highlights in results.)
  // A `/files/<path>` surface is a FOLDER page (#214), never a note — so no note row
  // is active there. Gating on the route (not just the eventually-cleared activeId)
  // also closes the one-frame window where the just-left note still lit ALONGSIDE the
  // freshly-active folder (activeId clears in a passive effect, a render late).
  const treeActiveId =
    route.kind === 'files' ? null : memoryNoteOpen ? activeId : !onChromePage ? activeId : null
  // The folder whose PAGE is the current surface (#214): light its row like the
  // active note's. Two shapes, both URL-derived (unambiguous, unlike nav state):
  //  - `/files/<path>` → a page-less folder's virtual page (the path IS the folder);
  //  - `/n/<pageNoteId>` where the note is a folder's index.md — hidden from the tree,
  //    so we light its FOLDER instead of no row. A regular note matches nothing here
  //    (its own row stays the active one), and chrome/memory surfaces resolve to null.
  const treeActiveFolderPath = useMemo(() => {
    if (route.kind === 'files') {
      return route.path || null
    }
    if (route.kind === 'note' && activeId && structure) {
      return structure.folders.find((f) => f.pageNoteId === activeId)?.path ?? null
    }

    return null
  }, [route, activeId, structure])

  // The explorer tree's lifecycle state (#220), computed once and handed to the
  // shared <TreeState> so every scope wears the ONE loading/error/empty skin. The
  // precedence mirrors the pre-#220 branch order EXACTLY (behaviour + per-state
  // testids preserved):
  //   1. Favorites' OWN cold signals (loading / cold error / no favorites) — its
  //      shelf loads independently of the file structure.
  //   2. Then the shared structural gates, which favorites-WITH-items ALSO obeys:
  //      the favorites view is BUILT from `folderTree` (favoriteTreeView), so an
  //      unloaded structure still shows the generic tree skeleton — not a favorites
  //      one — rather than flashing a half-built favorites tree.
  // Errors surface only on a COLD load (favorites gates on `!loaded`, the tree on
  // `!treeLoaded`) — a failed BACKGROUND refresh keeps the tree it already has and
  // lets SSE retry. `no-spaces` (#10) is a distinct empty and precedes the loading
  // gate (a zero-space principal never "loads" a tree).
  const isFavScope = effectiveScope.kind === 'favorites'
  const noSpaces = spaces.length === 0 && personalSpace?.slug !== space
  const favoritesEmpty = (
    <EmptyState
      variant="bare"
      icon={<IconStar size={18} />}
      title="No favorites yet"
      hint="Star notes, folders or projects to keep them here."
      testId="favorites-empty"
    />
  )
  let treeStatus: TreeStatus = 'ready'
  let treeSkeletonRows = 7
  let treeSkeletonTestId: string | undefined
  let treeErrorText: string | null = null
  let treeErrorTestId: string | undefined
  let treeEmpty: ReactNode = null

  if (isFavScope && favorites.loading) {
    treeStatus = 'loading'
    treeSkeletonRows = 5
    treeSkeletonTestId = 'favorites-skeleton'
  } else if (isFavScope && favorites.error && !favorites.loaded) {
    treeStatus = 'error'
    treeErrorText = favorites.error
    treeErrorTestId = 'favorites-error'
  } else if (isFavScope && favorites.items.length === 0) {
    treeStatus = 'empty'
    treeEmpty = favoritesEmpty
  } else if (listError && !treeLoaded) {
    treeStatus = 'error'
    treeErrorText = listError
    treeErrorTestId = 'list-error'
  } else if (noSpaces) {
    // A multi-user host can honestly serve zero spaces (#10): the principal simply
    // has no grants yet — say so instead of an empty tree that looks like a broken
    // load. The personal domain (#13) isn't in `spaces` but IS a real space, so when
    // it's active we fall through to its tree, not this dead-end.
    treeStatus = 'empty'
    treeEmpty = (
      <EmptyState
        variant="bare"
        icon={<IconWorkspace size={18} />}
        title="No spaces available"
        hint="Ask an admin to add you to one."
        testId="no-spaces"
      />
    )
  } else if (!treeLoaded) {
    treeStatus = 'loading'
    treeSkeletonTestId = 'tree-skeleton'
  } else if (treeRows.length === 0) {
    treeStatus = 'empty'
    treeEmpty = isFavScope ? (
      favoritesEmpty
    ) : effectiveScope.kind === 'projects' ? (
      // Projects view with nothing marked (#164): the actionable empty state.
      <EmptyState
        variant="bare"
        icon={<IconFolderKanban size={18} />}
        title="No projects yet"
        hint="Mark a folder as a project to focus on it."
        testId="projects-empty"
      />
    ) : (
      <EmptyState
        variant="bare"
        icon={<IconDoc size={18} />}
        title={effectiveScope.kind === 'project' ? 'This project is empty' : 'No notes yet'}
        hint={
          effectiveScope.kind === 'project'
            ? 'Add a note to this project.'
            : 'Create your first note to get started.'
        }
        testId="tree-empty"
      />
    )
  }

  // Folders are expand/collapse only (no "selected folder" highlight — clicking a
  // folder just toggles it, à la Obsidian/VS Code). browseFolder still drives the
  // reveal so the tree expands to the open/moved note or a deep-linked folder.
  const browseFolder = browsing && !memoryNoteOpen && nav.type === 'folder' ? nav.folder : null

  // The first skeleton unions every root into the open set, then latches so a later
  // Collapse all remains sticky.
  // canon: docs/drag-and-drop.md#5-reveal-expand-the-tree-to-the-active-item
  useEffect(() => {
    if (seeded.current || topLevelPaths.length === 0) {
      return
    }
    setOpenSet((prev) => seedTopLevel(prev, topLevelPaths))
    seeded.current = true
  }, [topLevelPaths])

  // Self-heal openSet against the server-authoritative skeleton (#97): the tree
  // carries EVERY folder (the directory channel loads atomically, never partially),
  // so any expanded path absent from it is stale — a renamed/moved/deleted folder's
  // old key, or a `carryOpenAcross` key that didn't take. Pruning here keeps the set
  // honest with ONE rule rather than bespoke cleanup at each mutation, and stops a
  // folder later recreated at an old path from inheriting a ghost "expanded".
  useEffect(() => {
    const live = new Set<string>()

    const walk = (nodes: readonly SkeletonNode[]) => {
      for (const n of nodes) {
        live.add(n.path)
        walk(n.children)
      }
    }
    walk(folderTree)
    if (live.size === 0) {
      return
    } // skeleton not loaded yet — don't prune the seed
    setOpenSet((prev) => {
      let changed = false
      const next = new Set<string>()

      for (const p of prev) {
        if (live.has(p)) {
          next.add(p)
        } else {
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [folderTree])

  // Reveal: expand the chain so the active item is visible. When a note is open
  // its file lives *inside* browseFolder, so open that folder too; when a folder
  // is merely selected, open just its ancestors (the folder row itself shows).
  useEffect(() => {
    if (!browseFolder) {
      return
    }
    const parts = browseFolder.split('/').filter(Boolean)

    if (!noteOpen) {
      parts.pop()
    }
    if (!parts.length) {
      return
    }
    setOpenSet((prev) => {
      const next = new Set(prev)
      let acc = ''
      let changed = false

      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p
        if (!next.has(acc)) {
          next.add(acc)
          changed = true
        }
      }

      return changed ? next : prev
    })
  }, [browseFolder, noteOpen])

  // Out-of-scope reveal (#164, Q3): opening a note the current scope would HIDE
  // bounces the explorer back to Files, so "the open note is always revealed in
  // the tree" holds (a search hit / wiki-link to a foreign folder doesn't vanish
  // from the rail). Keyed on the OPEN NOTE only (activeId + its folder) — reading
  // scope/projects through refs — so a deliberate focus while a foreign note is
  // open isn't undone; only NAVIGATING to a foreign note resets it. Favorites (#42)
  // is exempt by scopeHidesFolder returning false — opening a favorite note keeps
  // the rail on Favorites with no bounce-to-Files flicker (no /f route needed).
  //
  // Gate on `navigating`: at boot/deep-link `nav.folder` is the seeded `''`
  // PLACEHOLDER until fetchNote resolves the note's real folder. Acting on that
  // `''` would read EVERY project scope as "hides this note" (root is non-project)
  // and wrongly bounce a valid IN-scope deep-link to Files. While navigating, the
  // folder isn't known yet; the effect re-fires (nav.folder dep) once it lands.
  useEffect(() => {
    if (!noteOpen || !projectsReady || navigating) {
      return
    }
    if (scopeHidesFolder(scopeRef.current, nav.folder, isProjectRef.current)) {
      chooseScope({ kind: 'files' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, nav.folder, noteOpen, projectsReady, navigating])

  // Navigating OFF the merged Files section to a CHROME surface (Graph/Agents/
  // Trash/Settings/Management) clears a sticky `favorites` scope (#42), so a note
  // opened LATER from there reads as Files, not a re-lit star. Since #245 the Feed is
  // PART of the section (its default view), so it no longer triggers this reset — only
  // a true chrome surface does (this is the ONLY reset-condition change #245 makes:
  // dropping the old `nav.type==='feed'` trigger). Done as a POST-navigation effect
  // (not each rail link's onClick) so the Favorites icon never flickers to Files
  // mid-click: on the new surface it's already un-lit by the browsing gate, and the
  // scope resets silently underneath. Files itself is handled by its click
  // (leaveFavoritesOnNav) since it stays on the section. (An /m memory note is NOT
  // onChromePage and does not reset the lens — the pre-existing #42 behaviour, left
  // as-is: opening a memory note from a favorites-filtered file tree isn't a flow, so
  // widening this is out of #245's scope.)
  useEffect(() => {
    if (onChromePage) {
      clearFavoritesScope()
    }
  }, [onChromePage, clearFavoritesScope])

  return (
    <aside className={styles.rail}>
      {/* ── Activity strip — VS Code's Activity Bar: ALWAYS visible (#103). Logo,
          scope icons (Search/Feed/Graph/Agents/Files), "+", then sync + profile.
          It is the SOLE scope navigation now; the wide panel below only carries the
          space switcher + search + file tree. The collapse toggle hides that panel
          (not the strip), so navigation stays put whether the tree is shown or not. */}
      <nav className={styles.strip}>
        <Link
          to={homeHref}
          className={cx(styles.iconBtn, styles.railLogo)}
          title="Home"
          data-testid="rail-home"
        >
          <IconBrain size={18} />
        </Link>
        {/* Divider under the logo (same 1px var(--border) as the topbar's
            .action-sep) — sits on the chrome-band line, continuing the header rule. */}
        <div className={styles.railStripSep} aria-hidden="true" />
        {/* Rail order (#245): Files · Favorites · Agents · Graph ·
            Search · Trash. The merged Files section leads (it's where content lives);
            Favorites is its lens, so it follows. Search is demoted near the end — the
            rail icon is a REDUNDANT Spotlight trigger (⌘P + the topbar OmniSearch
            already reach it), so it doesn't earn top billing. Files/Agents/Graph/Trash
            are real <Link>s so a middle/ctrl click opens them in a new tab natively
            (#29 Journey #4); Feed lost its own icon (it's the Files section's default
            view — feed / folder page / note = one section, one icon). */}
        <div className={styles.railStripScopes}>
          {/* Files is the merged section's single entry (#245): a plain click opens
              its default view, the feed overview (filesHref → /feed); a middle/ctrl
              click opens it in a new tab. The icon lights across the whole section
              (feed / folder page / note). A plain click also switches the tree back
              to the GENERAL files view when you were in Favorites (#42) — the
              "Files" button must mean Files. */}
          <Link
            to={filesHref}
            className={cx(styles.iconBtn, filesActive && styles.on)}
            data-testid="rail-files"
            aria-current={filesActive ? 'page' : undefined}
            title="Files"
            onClick={leaveFavoritesOnNav}
          >
            <IconLayers size={17} />
          </Link>
          {/* Favorites (#42): the user's quick-return shelf — a client-side explorer
              lens (not a route), so it opens the rail and filters the tree. Sits right
              after Files (it's a subset/lens of it). */}
          <button
            className={cx(styles.iconBtn, favoritesActive && styles.on)}
            data-testid="rail-favorites"
            aria-pressed={favoritesActive}
            title="Favorites"
            onClick={() => {
              pickScope({ kind: 'favorites' })
              if (!railOpen) {
                toggleRail()
              }
            }}
          >
            <IconStar size={17} />
          </button>
          <Link
            to={agentsHref}
            className={cx(styles.iconBtn, onAgents && styles.on)}
            data-testid="rail-agents"
            aria-current={onAgents ? 'page' : undefined}
            title="Agents"
          >
            <IconBot size={17} />
          </Link>
          <Link
            to={graphHref}
            className={cx(styles.iconBtn, onGraph && styles.on)}
            data-testid="rail-graph"
            aria-current={onGraph ? 'page' : undefined}
            title="Graph"
          >
            <IconGraph size={17} />
          </Link>
          {/* Search opens Spotlight (#190): the rail no longer hosts a Search VIEW —
              quick-jump lives in the centred switcher (and the topbar OmniSearch),
              detailed search on the Feed. Demoted near the end (#245): a redundant
              trigger for ⌘P, it doesn't need top billing. */}
          <button
            className={styles.iconBtn}
            title="Search (⌘P)"
            data-testid="rail-search"
            onClick={() => spotlight.open()}
          >
            <IconSearch size={17} />
          </button>
          <Link
            to={trashHref}
            className={cx(styles.iconBtn, onTrash && styles.on)}
            data-testid="rail-trash"
            aria-current={onTrash ? 'page' : undefined}
            title="Trash"
          >
            <IconTrash size={17} />
          </Link>
          {/* No standalone "New" (+) on the rail strip (#245): it's dropped
              from the scope rail — creating lives in the panel head (Collapse ·
              Refresh · New, when the rail is open), the tree's right-click "New…"
              menu, and the note.new hotkey. */}
        </div>
        {/* Footer (#112) — mode-aware. Auth: a 1-click Settings gear over the
            avatar (which carries the sync staleness badge + a sync-led dropdown).
            No-auth (desktop/dev — no profile): the standalone sync glyph over the
            gear; Settings is already one click, so nothing to unbury. The bottom
            slot holds each mode's anchor — the avatar when signed in, else the gear. */}
        <div className={styles.railStripFoot}>
          {mode === AUTH_MODE.password ? (
            <>
              <SettingsGear />
              <ProfileButton />
            </>
          ) : (
            <>
              <SyncButton status={syncStatus} changedLastMinute={changedLastMinute} />
              <SettingsGear />
            </>
          )}
        </div>
      </nav>

      {/* ── Wide panel — space switcher + the file/memory tree. The collapse
          toggle (topbar / graph chip) shows/hides ONLY this; the strip stays.
          It stays MOUNTED and is hidden with CSS (not unmounted): the virtualized
          tree's measurement (@tanstack/react-virtual) doesn't survive a remount —
          it comes back with the right total height but zero rendered rows until a
          real resize — and CSS show/hide IS that resize, so the rows always return.
          Bonus: the scroll position survives a collapse round-trip. */}
      <div
        className={cx(styles.panel, !railOpen && styles.panelHidden)}
        style={
          {
            width,
            ...(panelHeadH ? { ['--panel-head-h' as string]: `${panelHeadH}px` } : {}),
          } as CSSProperties
        }
      >
        <div className={styles.panelResize} onMouseDown={startResize} />
        {/* The panel's fixed head — brand wordmark + space switcher — as ONE frosted
            band. It floats OVER the scroll (absolute, outside .rail-scroll) so it
            covers the tree's scrollbar top the same way the content topbar covers its
            scrollbar — one pattern, scrollbar tucks under the glass everywhere. The
            view re-claims the band via .rail-scroll's padding-top (= the measured head
            height, --panel-head-h). The brand MARK is on the strip's logo; here it's
            just the wordmark, so the two read as one "🧠 Notarium" across the divider.
            Search is a Spotlight/OmniSearch surface now (#190), not an inline rail view. */}
        <div ref={panelHeadRef} className={cx(styles.panelHead, 'glass')} data-testid="panel-head">
          <div className={styles.railHead}>
            <Link to={homeHref} className={styles.brand} title="Home">
              <span className={styles.brandName}>Notarium</span>
            </Link>
          </div>
          <SpaceSwitcher />
          {/* The view's header lives in the floating glass head (#31), PINNED so the
              tree rows scroll under it (VS Code's explorer header): Files/Projects/Memory
              scope picker + collapse/refresh/new. */}
          {
            // Right-click the header for the root "New…" menu — it moved into the head
            // with the row, so re-attach rootContextMenu here (it stays on the scroll
            // body too, for the empty area below the tree).
            <div className={styles.sectionHead} onContextMenu={rootContextMenu}>
              {/* The view selector (#164 + #165): Files / Projects / Memory + recent jumps. */}
              <ScopePicker
                scope={effectiveScope}
                projects={projects ?? []}
                recent={recentProjects}
                onPick={pickScope}
                onFocus={focusProject}
              />
              {/* Sort is shared by every explorer scope. Collapse all + Refresh + New
                  act on the FILES tree and stay hidden while Memory owns the rows. */}
              <div className={styles.sectionActions}>
                <SortButton
                  sort={explorerSort}
                  dir={explorerSortDir}
                  onSort={setExplorerSort}
                  onDir={setExplorerSortDir}
                />
                {effectiveScope.kind !== 'memory' && (
                  <>
                    <button
                      className={styles.iconBtn}
                      title="Collapse all"
                      aria-label="Collapse all folders"
                      data-testid="collapse-all"
                      onClick={collapseAll}
                      disabled={!treeLoaded || renderedOpenSet.size === 0}
                    >
                      <IconCollapse size={16} />
                    </button>
                    <button
                      className={styles.iconBtn}
                      title="Refresh"
                      aria-label="Refresh the file tree"
                      data-testid="refresh-tree"
                      onClick={() => void refreshTree()}
                      disabled={!treeLoaded || refreshing}
                    >
                      <IconRefresh size={16} className={cx(refreshing && styles.spin)} />
                    </button>
                    {canWrite && (
                      <NewButton
                        canCreateProject={canManageProjects}
                        onNewNote={() => void startNew(scopeRoot)}
                        onNewFolder={() => void doNewFolder(scopeRoot)}
                        onNewProject={() => void doNewProject()}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          }
        </div>
        <div className={styles.railScroll} ref={railScrollRef} data-testid="rail-scroll">
          <div
            className={cx(
              styles.navSection,
              styles.foldersSection,
              dropTarget === ROOT && styles.dropRoot,
            )}
            // Publish the DnD contract the window-level file-import dropzone (#223) reads
            // back (attr names via DND_ATTRS — untyped DOM strings, one source): the explorer
            // scope root (focused project's folder, else the space root) so a drop OUTSIDE the
            // tree resolves to "the section you're in", and the OPEN note's folder so a reader
            // drop lands next to what you're reading (absent when no note is open → the dropzone
            // falls back to the scope root).
            {...{
              [DND_ATTRS.scopeRoot]: scopeRoot,
              [DND_ATTRS.openFolder]:
                noteOpen && lastNote && lastNote.id === activeId
                  ? directoryOf(lastNote.filePath)
                  : undefined,
            }}
            onDragOver={sectionDragOver}
            onDragLeave={sectionDragLeave}
            onDrop={sectionDrop}
            onClick={sectionClick}
            onContextMenu={rootContextMenu}
          >
            {effectiveScope.kind === 'memory' ? (
              // The Agents surface (#165): the agent-memory audit owns its data
              // fetch + axes, but uses the same explorer virtual rows/reveal
              // primitive as Files (and the same TreeState skin). The right-aside
              // FolderFilter the old Memory page used is gone: the axes ARE the filter.
              <MemoryTree
                activeId={treeActiveId}
                scrollRef={railScrollRef}
                visible={railOpen}
                headH={panelHeadH}
              />
            ) : (
              // Every non-memory scope (files, project, projects, favorites) wears the
              // ONE shared lifecycle skin (#220): loading→skeleton, cold error→Notice,
              // empty→the scope's EmptyState, ready→the virtualized tree. The status +
              // empty node are computed above so this stays a single, uniform mount.
              <TreeState
                status={treeStatus}
                skeletonRows={treeSkeletonRows}
                skeletonTestId={treeSkeletonTestId}
                error={treeErrorText}
                errorTestId={treeErrorTestId}
                empty={treeEmpty}
              >
                <VirtualTree
                  rows={treeRows}
                  scrollRef={railScrollRef}
                  visible={railOpen}
                  headH={panelHeadH}
                  activeId={treeActiveId}
                  activeFolderPath={treeActiveFolderPath}
                  movedId={movedId}
                  onOpen={openNote}
                  openSet={renderedOpenSet}
                  toggle={toggle}
                  dnd={dnd}
                  tree={treeApi}
                  revealNonce={revealNonce}
                />
              </TreeState>
            )}
          </div>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}
